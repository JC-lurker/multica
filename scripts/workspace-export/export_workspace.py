#!/usr/bin/env python3
"""Read-only export of a Multica workspace to a local folder via the `multica` CLI.

Usage: export_workspace.py OUT_DIR
Contains private data: keep OUT_DIR local, never upload. Secrets (agent env values)
are NOT read; only key counts are recorded.
"""
import json, os, subprocess, sys, datetime, concurrent.futures as cf

OUT = os.path.abspath(sys.argv[1])
STATUSES = ["backlog", "todo", "in_progress", "in_review", "blocked", "done", "cancelled", "deployed"]
errors = []


def run(args, retries=2):
    last = None
    for _ in range(retries + 1):
        p = subprocess.run(["multica", *args], capture_output=True, text=True)
        if p.returncode == 0:
            return p.stdout
        last = p.stderr.strip()
    raise RuntimeError(f"multica {' '.join(args)}: {last}")


def jget(args, default=None):
    try:
        out = run(args)
        return json.loads(out) if out.strip() else default
    except Exception as e:  # record, keep going
        errors.append(str(e))
        return default


def dump(path, obj):
    path = os.path.join(OUT, path)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(obj, f, indent=2, ensure_ascii=False)


def items(obj, *keys):
    if isinstance(obj, list):
        return obj
    if isinstance(obj, dict):
        for k in keys:
            if isinstance(obj.get(k), list):
                return obj[k]
        for v in obj.values():
            if isinstance(v, list):
                return v
    return []


def list_issues():
    seen = {}
    for st in [None] + STATUSES:
        off = 0
        while True:
            a = ["issue", "list", "--limit", "100", "--offset", str(off), "--output", "json"]
            if st:
                a += ["--status", st]
            d = jget(a, {})
            page = items(d, "issues")
            for i in page:
                seen[i["id"]] = i
            if not page or not (isinstance(d, dict) and d.get("has_more")):
                break
            off += len(page)
    return list(seen.values())


def fetch_comments(iid):
    return jget(["issue", "comment", "list", iid, "--full", "--output", "json"], [])


def fetch_issue(i):
    iid = i["id"]
    full = jget(["issue", "get", iid, "--output", "json"], i)
    comments = fetch_comments(iid)
    extra = {
        "children": jget(["issue", "children", iid, "--output", "json"]),
        "timeline": jget(["issue", "timeline", iid, "--output", "json"]),
        "runs": jget(["issue", "runs", iid, "--output", "json"]),
        "pull_requests": jget(["issue", "pull-requests", iid, "--output", "json"]),
        "properties": jget(["issue", "property", "list", iid, "--output", "json"]),
        "subscribers": jget(["issue", "subscriber", "list", iid, "--output", "json"]),
    }
    return iid, full, comments, extra


def main():
    os.makedirs(OUT, exist_ok=True)
    counts = {}

    dump("workspace.json", jget(["workspace", "get", "--output", "json"]))

    agents = items(jget(["agent", "list", "--include-archived", "--output", "json"], []), "agents")
    full_agents = []
    for a in agents:
        g = jget(["agent", "get", a["id"], "--output", "json"], a)
        g["_skills"] = jget(["agent", "skills", "list", a["id"], "--output", "json"])
        g["_mcp"] = jget(["agent", "mcp", "list", a["id"], "--output", "json"])
        full_agents.append(g)
    dump("agents.json", full_agents)
    counts["agents"] = len(full_agents)
    # secrets: env values never read; list agents that have keys needing re-entry
    dump("agents_secrets_needing_reentry.json", [
        {"id": a.get("id"), "name": a.get("name"), "custom_env_key_count": a.get("custom_env_key_count")}
        for a in full_agents if a.get("custom_env_key_count")])

    skills = items(jget(["skill", "list", "--output", "json"], []), "skills")
    full_skills = []
    for s in skills:
        full_skills.append(jget(["skill", "get", s["id"], "--with-content", "--output", "json"], s))
    dump("skills.json", full_skills)
    counts["skills"] = len(full_skills)

    projects = items(jget(["project", "list", "--output", "json"], []), "projects")
    for p in projects:
        p["_resources"] = jget(["project", "resource", "list", p["id"], "--output", "json"])
        p["_detail"] = jget(["project", "get", p["id"], "--output", "json"])
    dump("projects.json", projects)
    counts["projects"] = len(projects)

    squads = items(jget(["squad", "list", "--output", "json"], []), "squads")
    for s in squads:
        s["_detail"] = jget(["squad", "get", s["id"], "--output", "json"])
        s["_members"] = jget(["squad", "member", "list", s["id"], "--output", "json"])
    dump("squads.json", squads)
    counts["squads"] = len(squads)

    aps = items(jget(["autopilot", "list", "--output", "json"], []), "autopilots")
    for a in aps:
        a["_detail"] = jget(["autopilot", "get", a["id"], "--output", "json"])
        a["_triggers"] = jget(["autopilot", "trigger-list", a["id"], "--output", "json"])
        a["_runs"] = jget(["autopilot", "runs", a["id"], "--output", "json"])
    dump("autopilots.json", aps)
    counts["autopilots"] = len(aps)

    labels = jget(["label", "list", "--output", "json"], [])
    dump("labels.json", labels)
    counts["labels"] = len(items(labels, "labels"))
    props = jget(["property", "list", "--output", "json"], [])
    dump("properties.json", props)
    counts["properties"] = len(items(props, "properties"))

    issues = list_issues()
    counts["issues"] = len(issues)
    ncomments = 0
    att = {}
    with cf.ThreadPoolExecutor(6) as ex:
        for iid, full, comments, extra in ex.map(fetch_issue, issues):
            cl = items(comments, "comments")
            ncomments += len(cl)
            dump(f"issues/{full.get('identifier', iid)}.json", {"issue": full, "comments": cl, **extra})
            for a in (full.get("attachments") or []):
                att[a["id"]] = a
            for c in cl:
                for a in (c.get("attachments") or []):
                    att[a["id"]] = a
    counts["comments"] = ncomments

    # attachments
    adir = os.path.join(OUT, "attachments")
    os.makedirs(adir, exist_ok=True)
    ok = 0
    def dl(a):
        d = os.path.join(adir, a["id"])
        os.makedirs(d, exist_ok=True)
        try:
            run(["attachment", "download", a["id"], "-o", d])
            return True
        except Exception as e:
            errors.append(str(e))
            return False
    with cf.ThreadPoolExecutor(4) as ex:
        ok = sum(ex.map(dl, att.values()))
    dump("attachments_index.json", list(att.values()))
    counts["attachments_found"] = len(att)
    counts["attachments_downloaded"] = ok

    dump("manifest.json", {
        "exported_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "server": os.environ.get("MULTICA_SERVER_URL"),
        "workspace_id": os.environ.get("MULTICA_WORKSPACE_ID"),
        "counts": counts,
        "errors": errors,
    })
    print(json.dumps({"counts": counts, "errors": len(errors)}, indent=2))


main()
