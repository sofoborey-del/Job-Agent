# Always-on discovery and Discord: deployment gate

This is a **prepared deployment**, not a live cloud service. No server has been chosen, no data
has been transferred, and the Windows sign-in task remains the active instance. The hosted mode is
only for scheduled, reviewed job discovery, matching, and outbound Discord delivery. It does not
offer a public tracker, Discord slash commands, real employer form interaction, or submission.

## Before go-live

1. Complete the outstanding Phase 1B shortlist-quality review in
   `phase-1b-discovery.md` with about ten real adverts. Include linked criteria
   documents and record whether the shortlist is trustworthy. Do not call the phase signed off
   because a synthetic test or one Adzuna search passed.
2. Choose an always-on host with persistent disk, outbound HTTPS, restricted administrator access,
   backup capability, and a predictable monthly spend. The container publishes **no ports**. Do
   not add a reverse proxy, public IP mapping, or tunnel for its API without a separate access and
   threat-model review.
3. Make an offline, restorable backup of the local encrypted database and artifacts. Stop the
   Windows `JobApplicationAgent` task first so PGlite is closed before copying its files. Record
   the encryption-key ID and profile ID separately; never paste the key or tokens into chat.
4. Transfer the database, artifacts, and secret values only through an encrypted channel to the
   chosen host. Keep the existing encryption key when moving the existing profile. Give the filled
   `.env.hosted` file owner-only permissions and keep it out of Git and container images.
5. Import the data into the `job-application-agent-data` volume. Do not start the scheduler against
   an empty volume and assume the profile has migrated. Run migrations with the agent stopped,
   then check that the approved profile, reviewed Adzuna source, site policy, and tracked jobs are
   present. Use one writer only: do not run the Windows and hosted schedulers together.
6. Run the container, check its health, one scheduled search, and one real outbound notification
   outside quiet hours. Confirm duplicate runs do not create duplicate jobs or notifications.
   Only then leave the Windows task disabled as a recoverable fallback.

The exact encrypted transfer, import, firewall, and backup commands depend on the chosen host and
must be checked before executing them. No automatic migration or secret upload is provided here.

## Hosted package

- `Dockerfile.discovery` builds the pinned Node/pnpm project and runs it as an unprivileged user.
- `compose.discovery.yml` has a persistent volume and **no published ports**. The API binds to
  loopback inside the container, so even another container on its network cannot reach it.
- `AGENT_DEPLOYMENT_MODE=discovery_only` omits the fake-ATS application routes and inbound Discord
  command handler; the health response reports browser automation disabled. Startup fails if any
  source besides the reviewed Adzuna text source is enabled in the migrated database.
- `.env.hosted.example` lists the required settings without real values. The filled
  `.env.hosted` file is ignored by Git and excluded from the image build context.
- The health check fails when scheduling or Discord delivery is not ready, or if browser automation
  is unexpectedly enabled. A healthy container is not evidence that matching quality is signed off.

On a prepared host, the operator can validate the Compose file, build, run the migration command
while the agent is stopped, start it, and inspect its status with:

```sh
docker compose -f compose.discovery.yml config --quiet
docker compose -f compose.discovery.yml build
docker compose -f compose.discovery.yml run --rm --no-deps agent node apps/api/dist/migrate.js
docker compose -f compose.discovery.yml up -d
docker compose -f compose.discovery.yml ps
```

Do not run those commands with the real profile until the backup, import, and single-writer checks
above are done. Logs may contain job titles and operational metadata; keep host access private.
Back up the volume regularly and test restoration. A container restart is not a backup.

The image has no Windows Defender. In hosted mode, do not enable sources that require linked
document scanning or upload CVs there. Such scans fail closed; this deployment is limited to the
already reviewed Adzuna text source. A cross-platform scanner and its own safety review would be
required before expanding hosted document ingestion.

If anything goes wrong, stop the hosted container and re-enable the Windows task against the
untouched local data. Do not run both simultaneously or copy a live PGlite directory.
