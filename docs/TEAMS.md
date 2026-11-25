# Microsoft Teams

Staff message **O'Dea Assistant** in Teams: in a 1:1 chat, or by
@mentioning it in a team channel or group chat. It gives the same answers as
the web page, because both go through `ChatService`
(`orchestrator/src/chat/service.ts`).

```
Teams ──► Azure Bot Service ──► https://<public host>/api/messages
                                   │  (Cloudflare Tunnel: outbound only,
                                   │   no firewall ports opened at school)
                                   ▼
                     orchestrator on the school server
```

Code: `orchestrator/src/channels/teams.ts`, built on the Microsoft 365
Agents SDK (`@microsoft/agents-hosting`, the successor to the Bot Framework SDK).

## How it behaves

- Only accounts in O'Dea's Microsoft 365 tenant are answered.
- Role comes from Entra ID group membership (Microsoft Graph), so the
  staff-only launch is enforced by the server, not just by who installed the app.
- Teams waits only about 15 seconds for a reply, so the bot shows "typing…",
  then posts the answer when it's ready.
- "new chat" starts over. A chat's context is kept for an hour of inactivity.
- Photos sent in Teams aren't read yet (planned). The web page handles photos.

## Setup (IT / Microsoft 365 admin)

1. **Entra ID app registration** (Azure portal → App registrations → New):
   single tenant. Create a client secret. Note the **Application (client) ID**,
   **Directory (tenant) ID** and secret: these are `clientId`, `tenantId` and
   `clientSecret` in `.env`.
2. **API permission for roles:** Microsoft Graph → Application permission
   `GroupMember.Read.All` → *Grant admin consent*. Put the staff group's
   object id in `TEAMS_STAFF_GROUP_IDS`.
3. **Azure Bot resource** (Azure portal → Create → Azure Bot): type
   *Single Tenant*, use the app registration from step 1. Under
   *Channels*, add **Microsoft Teams**. Set the *Messaging endpoint* to
   `https://<public host>/api/messages`.
4. **Public address without opening ports:** in Cloudflare Zero Trust, create
   a tunnel and put its token in `CLOUDFLARE_TUNNEL_TOKEN`. Add a public
   hostname whose **path is `^/api/messages$`** and service
   `http://orchestrator:8080`. Route nothing else. Start it with
   `docker compose --profile teams up -d`.
   (Alternatives: Azure Relay, or a reverse proxy in the school DMZ.)
5. In `.env`: `TEAMS_ENABLED=true`, then restart the orchestrator. Check
   `GET /api/health` shows `"teams": true`.
6. **Build the app package:**
   ```bash
   TEAMS_APP_ID=$(uuidgen) clientId=<from step 1> WEBSITE_URL=https://www.odea.org \
   PRIVACY_URL=<school privacy page> TERMS_URL=<school terms page> \
   python3 teams/build-package.py
   ```
   Keep the `TEAMS_APP_ID` you generated; reuse it for later versions.
7. **Teams admin center** → Teams apps → Manage apps → *Upload new app* →
   `teams/package/odea-assistant.zip`. For the staff-only launch, use an
   **app setup policy / availability** limited to the staff group, and
   optionally pin the app for them.

## Security notes

- Every request to `/api/messages` is checked with the SDK's JWT validation
  (signed by the Bot Service, for our `clientId`); others get 401.
- The tunnel exposes only `/api/messages`; the web page stays on the school
  network behind Microsoft 365 sign-in.
- If the Graph lookup fails, the user gets the lowest configured role
  (fail closed), so with `ASSISTANT_MIN_ROLE=staff` they're turned away.
