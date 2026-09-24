# Railway handover plan

Prepared September 14, 2026. Data import is deferred until Kumon's export format is known. It is not a dependency for preparing this ownership handover. No project transfer, invitation, billing change, or account change has been performed by creating this plan.

## Recommended approach

Transfer the existing running Railway project into an approved Kumon-owned Railway workspace. Keep the application and PostgreSQL database together as one project. This transfers the installation that has already been deployed and checked, instead of asking Kumon to install the software again.

Treat hosting ownership, application administrator access, and source-code ownership as three distinct handover items. All three must be complete for Kumon to operate independently. Regular center staff need only the CRM address and their own staff login; Railway access belongs to the designated technical administrator.

For this handover, the receiving legal entity may be corporate or an approved franchise operator. Confirm the receiving entity and account before initiating a transfer. The running installation can remain in the current workspace during development.

## Kumon's setup

Kumon should only need to:

1. Nominate a primary administrator and a backup contact using company-controlled email addresses.
2. Provide an approved Railway workspace with an eligible paid plan, billing, MFA, and recovery ownership. If the workspace does not exist, create it with their administrator during an assisted setup session.
3. Grant the temporary access needed to complete the transfer, activate their named CRM administrator account, and confirm the handover checks.

No center employee should need to install Node, create database tables, copy environment variables, or use the Railway CLI. We handle those technical tasks. Any required corporate procurement or cloud-provider approval should happen before the transfer appointment.

There is no recurring CRM license fee in the proposed ownership model. Railway hosting, backups, domains, and other selected third-party services remain operating expenses billed to Kumon. A handover does not eliminate those costs.

## Prepare before adoption

| Preparation | Completion evidence |
| --- | --- |
| Name the release | Tag the reviewed application version; retain source, lockfile, migrations, deployment configuration, and test results |
| Deliver the source | Put the repository in Kumon's approved source-control organization, or deliver an importable Git bundle while their repository is arranged. Include a readable source archive. Confirm a future build does not depend on this development machine or a personal account |
| Set up the app administrator | Provide a short-lived owner activation flow, password/MFA setup, recovery, and staff management. An existing bootstrap password is not the finished onboarding process |
| Configure operations | Set backup schedules and alert recipients, verify a restore in an isolated environment, document attendance retention and contingency procedures, and assign an owner for future updates and incidents |
| Inventory dependencies | List services, volumes, domains, variables by name, external accounts, and deployment credentials without putting secrets in the handover document |
| Prepare recovery | Keep a protected pre-transfer database export and verify access to the agreed backup/recovery path. A successful export alone is not proof of restore readiness |
| Prepare the handover record | List what transfers with Railway and what needs separate ownership or credential changes, with the Kumon contact for each |

The existing project uses CLI deployments. No Git remote is configured in the local repository. We should arrange a Kumon-owned repository and verify its deployment path before removing developer access. Railway must be able to access the receiving repository if GitHub-based deployments are chosen.

## Transfer appointment

1. Confirm the receiving workspace, its administrator, paid-plan eligibility, and billing. Verify the implementer has administrative rights on the source project and the required membership in the destination workspace.
2. Confirm the release, current health, backup/export, and maintenance window. Avoid simultaneous deployments or configuration changes during the transfer.
3. In the existing project's Railway settings, use **Transfer Project** and select the approved Kumon workspace. Transfer the project as a unit, including the web service and PostgreSQL service. If transferring directly to another user instead, Railway documents a recipient acceptance email with a 24-hour acceptance window.
4. Verify the project and its resources appear under Kumon's control. Confirm the application URL, database connection, persistent volume, environment variables, health check, and billing ownership. Plan to retain the current application address; verify continuity after the platform operation rather than promising untested zero downtime.
5. Have Kumon's administrator sign in to the CRM and exercise the agreed read-only acceptance checks. Confirm staff access and recovery ownership. Any operational test records must be explicitly agreed and isolated from real attendance history.
6. Rebind repository or registry access where needed. Verify a controlled future deployment from Kumon-controlled source and credentials.
7. Rotate shared/bootstrap credentials and deployment tokens in a coordinated sequence. Update dependent services together and verify them before retiring the old credentials. Remove temporary developer access after the agreed acceptance period, unless Kumon explicitly retains a scoped support role.

Railway documents workspace/project transfer functionality, but this plan has not executed a transfer on the current installation. Destination permissions and provider requirements must be checked at the actual handover.

## What stays and what changes

| Item | Plan |
| --- | --- |
| Running application and database | Continue with the existing project and persisted data; verify service and volume continuity after transfer |
| CRM address | Retain the current Railway address initially. A Kumon-owned custom domain can be configured separately when DNS access is available |
| Hosting ownership and payment | Move to the approved Kumon account/workspace and billing owner |
| CRM administrator | Activate a named Kumon owner with independent recovery access |
| Source and future deployments | Deliver to Kumon-controlled storage/repository and verify the build/deployment path |
| Backups and alert recipients | Verify ownership, schedules, access, and notifications after transfer; separately hand over any external storage or monitoring accounts |
| Temporary implementation access | Remove or reduce to the specifically agreed support scope after acceptance |
| Import | Remains a separate, deferred workstream until the source export is known |

Transferring a Railway project does not automatically transfer a separate GitHub repository, domain registration, email provider, external backup account, or contractual ownership rights to custom code. Handle any such items explicitly in the ownership checklist.

## Minimal delivery pack

Provide the application URL, account ownership record, source release, deployment instructions, service/dependency inventory, staff and administrator guides, backup/restore runbook, export instructions, update/rollback procedure, known limitations, and the support/warranty terms. Deliver credentials through the agreed secure channel, separately from these documents.

The handover is complete when Kumon's designated administrator can access the application and infrastructure, recover accounts, see hosting bills and alerts, retrieve backups, deploy the approved release, and remove our temporary access without disabling the system. Staff training and the outstanding operational attendance controls still need acceptance before real student use.

## Current installation

- Project: [Kumon CRM](https://railway.com/project/83fb1c4c-5246-4250-8e00-a4fc4053c5ff)
- Application: [web-production-ce255.up.railway.app](https://web-production-ce255.up.railway.app)
- Services: `web` and `Postgres`
- Source location: `/Users/ocheng/Documents/ChatGPT/Safu`
- Existing deployment configuration: `railway.json`, with build/start commands and `/api/health`
- Already completed: empty-by-default workspace, live PostgreSQL connection, staff session authentication, and basic workflow verification
- Still needed for this handover package: receiving account, company-owned source/deployment access, named-owner activation/recovery and staff administration, verified backup/restore and operational controls, and final acceptance

## References

Railway documentation checked September 14, 2026:

- [Projects and ownership transfers](https://docs.railway.com/projects#transferring-projects): workspace transfers, source administrative permission, destination membership/plan requirements, and direct-user transfer acceptance.
- [Workspace administration](https://docs.railway.com/projects/workspaces): workspace creation, roles, billing, and project transfers.
- [Project member permissions](https://docs.railway.com/projects/project-members): project access roles and ownership responsibilities.

Railway's project-transfer documentation currently lists active Hobby/Pro plan prerequisites, while company workspaces have their own Pro/Enterprise setup options. Confirm the selected corporate plan's transfer route with Railway if it differs from the documented standard flow.
