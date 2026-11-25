#!/usr/bin/env python3
"""Build teams/package/odea-assistant.zip, the file a Teams admin uploads in
the Teams admin center (Teams apps -> Manage apps -> Upload new app).

    TEAMS_APP_ID=<uuid, generate once and keep> clientId=<bot app id> \
    WEBSITE_URL=https://www.odea.org PRIVACY_URL=... TERMS_URL=... \
    python3 teams/build-package.py
"""
import json, os, pathlib, string, sys, zipfile

here = pathlib.Path(__file__).parent / "package"
names = ["TEAMS_APP_ID", "clientId", "WEBSITE_URL", "PRIVACY_URL", "TERMS_URL"]
missing = [n for n in names if not os.environ.get(n)]
if missing:
    sys.exit(f"Set {', '.join(missing)}")

# safe_substitute leaves the manifest's own "$schema" key alone.
manifest = string.Template((here / "manifest.template.json").read_text()).safe_substitute(
    {n: os.environ[n] for n in names}
)
left = [n for n in names if "${" + n + "}" in manifest]
if left:
    sys.exit(f"Placeholders not filled: {left}")
json.loads(manifest)  # fail early on a broken manifest

out = here / "odea-assistant.zip"
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("manifest.json", manifest)
    z.write(here / "color.png", "color.png")
    z.write(here / "outline.png", "outline.png")
print(f"Built {out}")
