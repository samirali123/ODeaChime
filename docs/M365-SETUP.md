# Microsoft 365 / Azure setup (admin checklist)

Everything a Microsoft 365 admin does for ODeaChime, in order. Allow about
an hour. Fill in the right-hand column as you go: those values go into `.env`
on the server.

| Value | Where it comes from | `.env` name |
|---|---|---|
| Tenant ID | Step 2 | `tenantId` |
| Staff group object ID | Step 1 | `STAFF_GROUPS` and `TEAMS_STAFF_GROUP_IDS` |
| Web app client ID / secret | Step 2 | `WEB_SSO_CLIENT_ID` / `WEB_SSO_CLIENT_SECRET` |
| Bot app client ID / secret | Step 3 | `clientId` / `clientSecret` |
| Bot public hostname | Step 5 | (Azure Bot messaging endpoint) |

## 0. Pick two hostnames

- **Web page (internal):** e.g. `odeachime.odea.org`, pointing at the
  server's LAN IP in your internal DNS. This becomes `SITE_ADDRESS`.
- **Teams bot (public):** e.g. `odeachime-bot.<a domain on Cloudflare>`.
  Teams' servers must reach this one from the internet (step 5).

## 1. Staff group (Entra admin center → Groups)

Use an existing **security group** that holds all staff, or create
**ODeaChime Staff** (type *Security*). With Entra ID P1 (included in
Microsoft 365 A3/A5) you can make it a *dynamic* group, for example
`user.jobTitle -ne "Student"`, so it maintains itself.
Copy the group's **Object ID**.

## 2. App registration: web sign-in

Entra admin center → Identity → Applications → **App registrations → New registration**

1. Name **ODeaChime Web**. Supported account types: **Single tenant**.
   Redirect URI: platform **Web**, `https://<SITE_ADDRESS>/oauth2/callback`.
2. Overview: copy **Application (client) ID** and **Directory (tenant) ID**.
3. **Certificates & secrets** → New client secret, 24 months → copy the
   **Value** now (it's shown once). Put a calendar reminder to renew it before it expires.
4. **Token configuration** → Add groups claim → **Security groups** →
   under *ID*, choose **Group ID** → Add.
5. **API permissions**: the default *User.Read* (delegated) is enough. Click
   **Grant admin consent** so staff don't see a consent prompt.
6. Staff-only at the Microsoft level too: Entra admin center → **Enterprise
   applications → ODeaChime Web → Properties → Assignment required: Yes**,
   then **Users and groups → Add** the staff group. Non-staff can't even
   sign in.

## 3. App registration: Teams bot

1. New registration **ODeaChime Bot**, **Single tenant**, no redirect URI.
2. Copy its **Application (client) ID**, and create a **client secret** as above.
3. **API permissions → Add → Microsoft Graph → Application permissions →
   GroupMember.Read.All** → **Grant admin consent**. The bot uses this to
   check whether a Teams user is in the staff group. If the server log
   shows `Teams role lookup failed: Graph answered 403`, also add
   **User.ReadBasic.All** (application) and grant consent.

## 4. Azure Bot (Azure portal; needs an Azure subscription)

portal.azure.com → **Create a resource → Azure Bot**

1. Bot handle `odeachime-bot`. Pricing tier **Free (F0)**. The Teams
   channel is free.
2. Type of App: **Single Tenant**. Creation type: **Use existing app
   registration**. App ID = the bot app from step 3, tenant ID from step 2.
3. After it's created: **Settings → Configuration → Messaging endpoint** =
   `https://<bot public hostname>/api/messages` → Apply.
4. **Settings → Channels → Microsoft Teams** → accept the terms → Apply.

No Azure subscription? The school can create one under its Microsoft 365
tenant (Azure for Education or pay-as-you-go). The F0 bot costs nothing.

## 5. Public address for the bot (Cloudflare Tunnel)

Teams must reach `/api/messages` from the internet. The tunnel connects
**outbound** from the server, so no firewall ports open.

1. Cloudflare dashboard (free plan) with a domain on Cloudflare: either
   move a spare domain there, or delegate a subdomain of odea.org.
2. Zero Trust → Networks → **Tunnels → Create a tunnel** (cloudflared) →
   copy the **token** → `CLOUDFLARE_TUNNEL_TOKEN` in `.env`.
3. Public hostname: `odeachime-bot.<domain>`, **path `^/api/messages$`**,
   service `http://orchestrator:8080`. Add nothing else.

## 6. Fill in `.env` on the server and start

```bash
cp .env.example .env
```

Fill in the values from the table above, plus `ANTHROPIC_API_KEY`,
`POSTGRES_PASSWORD`, `WEB_SSO_COOKIE_SECRET`, `BELLFORGE_SYNC_TOKEN`, and
`TEAMS_ENABLED=true`. Then:

```bash
docker compose --profile teams up -d
```

Check that `https://<SITE_ADDRESS>/api/health` (after signing in) shows `"teams": true`.

## 7. Teams app (Teams admin center)

1. Build the package on any computer with Python:
   ```bash
   TEAMS_APP_ID=$(uuidgen) clientId=<bot app id> WEBSITE_URL=https://www.odea.org PRIVACY_URL=<privacy page> TERMS_URL=<terms page> python3 teams/build-package.py
   ```
   Save the `TEAMS_APP_ID`; reuse it for every later version.
2. admin.teams.microsoft.com → **Teams apps → Manage apps → Upload new
   app** → `teams/package/odeachime.zip`.
3. Open **ODeaChime** in Manage apps → **Users and groups → Available to
   specific users or groups** → the staff group.
4. Optional: **Teams apps → Setup policies** → a policy for the staff group
   that **pins** ODeaChime, so it appears in their Teams sidebar.
5. If upload is blocked: **Org-wide app settings → Custom apps** must be allowed.

Changes in the Teams admin center can take a few hours to reach everyone.

## 8. Test

- Web: open `https://<SITE_ADDRESS>`. You should get the Microsoft sign-in,
  then the chat. A non-staff test account should be refused.
- Teams: find ODeaChime in Apps, send "What schedule is today?".

## Ongoing

- Client secrets expire (steps 2 and 3): renew them and update `.env`.
- Staff join or leave by group membership; nothing to change in ODeaChime.
