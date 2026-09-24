# Kumon CRM Cloudflare v1 delivery plan

Prepared September 14, 2026. Planning document for the customer-owned Cloudflare edition. None of the planned Cloudflare features or tests below should be represented as completed.

## Product and commercial objective

Sell a perpetual software license and installation for a one-time fee. Deploy into the franchisee's own Cloudflare account, deliver source code and deployment documentation, and charge no recurring license fee. The buyer controls its application instance, records, administrator access, and future maintenance choices.

Design for Cloudflare's currently available free allowances at a measured single-center workload. Publish the validated workload and any dependencies with the release. Do not advertise guaranteed zero costs forever or claim that a perpetual license transfers copyright outright.

Optional future upgrades, new features, and maintenance can be sold separately. Existing licensed features must continue operating without our license server, account, renewal, or maintenance plan.

## Scope and decisions

| Area | v1 direction | Status |
| --- | --- | --- |
| Hosting | Customer-owned Cloudflare account, Hono API on Workers, D1 database, reusable React interface | Agreed direction; migration not implemented |
| Frontend deployment | Evaluate serving React as Worker static assets alongside the API; retain Pages if it is the better fit | Engineering decision in feasibility milestone |
| Installation unit | Recommend one center per v1 installation, owned by its franchise business | Proposed scope boundary to confirm before implementation |
| Multiple locations | A franchisee can own several installations; account allowances are shared when installations use the same account | Multi-location dashboards and one-login center switching are outside the proposed first release |
| Back-office identity | Cloudflare Access with named users; target 5 to 10 staff per center | Selected approach, subject to end-to-end validation |
| Front desk | Enrolled iPad kiosk with restricted permissions and individual staff PINs | Selected workflow; security design still required |
| Offline synchronization | Defer durable offline writes, local event journal, and automatic reconciliation to a later release | Explicit v1 exclusion |
| Connection failure | Connection status, last successful refresh, safe retries, and an agreed operating procedure | Required in v1 |
| Import | Generic bulk CSV roster import with preview and validation | Required in v1; Kumon-specific mapping waits for a representative export |
| Backup | D1 recovery plus encrypted nightly backups to customer-controlled Google Drive | Required; execution cost and independent restoration must be tested |
| Attendance retention | At least two years of reviewable records; protect linked evidence | Required; no automatic deletion exactly at two years |
| Readiness report | Evidence mapped to the supplied eight requirements, with center attestations and unresolved items | Required; not an automatic compliance certificate |
| Support | 30 days of setup support following written acceptance | Agreed commercial direction; warranty terms still to define |

The installation unit is a commercial scope decision. If the first buyer requires several locations within one installation, add explicit user-to-center memberships, scoped roles, a real center selector, and cross-center tests before estimating that release. Do not represent those capabilities as already built.

## Current implementation

The existing application uses React, Express, PostgreSQL on Railway, and PGlite for local development. It includes students and guardians, inquiries, schedules, attendance, corrections, reports, server-side roles, and center-scoped queries. Default workspaces start empty.

Accounts currently belong to one center. The application lacks the full owner administration, Cloudflare deployment, Access integration, kiosk enrollment, CSV import, automatic Google Drive backups, and verified recovery package proposed here.

The current client polls every five seconds and the bootstrap endpoint loads historical collections. This pattern must change before claiming suitability for D1's free allowance. Existing PostgreSQL and PGlite tests are useful regression evidence, but they do not establish D1 transaction correctness or Cloudflare resource usage.

Keep synthetic feasibility and acceptance data in isolated test installations. Never populate the existing empty customer workspace with demonstration records. Preserve unrelated ongoing work in this repository.

## Delivery sequence

| Milestone | Primary owner | Depends on | Exit evidence |
| --- | --- | --- | --- |
| 0. Confirm product boundary | Product lead and buyer representative | None | Written scope and commercial assumptions |
| 1. Prove Cloudflare feasibility | Engineering | 0 | Working vertical slice and resource measurements |
| 2. Complete identity and kiosk access | Engineering | 1 | Access, permission, device, and PIN test results |
| 3. Port core CRM and attendance | Engineering | 1; integrates with 2 | D1 regression tests and bounded data loading |
| 4. Deliver CSV roster import | Engineering and center reviewer | 2, 3 | Import reconciliation and retry tests |
| 5. Complete recovery and outage procedures | Engineering and center operator | Prototype in 1; production design after 2, 3 | Restore drill, backup failure tests, contingency demonstration |
| 6. Deliver retention and readiness evidence | Engineering and center operator | 3, 4, 5 | Eight-requirement report and retention checks |
| 7. Package installation and upgrades | Engineering | 2 through 6 | Repeatable installation and customer-independent recovery |
| 8. Pilot, accept, and hand over | Product lead and buyer | All previous milestones | Signed acceptance and access handover record |

Draft the agreement and obtain the center's operating procedures while engineering proceeds. Do not promise a delivery date or fixed free-usage capacity before milestone 1 resolves the platform constraints.

## 0. Confirm the product boundary

- [ ] Confirm the contracting franchise business and the initial number of locations, staff, and kiosk devices.
- [ ] Confirm whether v1 is one center per installation or includes a multi-location workspace.
- [ ] Record the source-code license, permitted locations, modification rights, and right to appoint another maintainer. Distinguish these rights from copyright assignment.
- [ ] Confirm which account owns Cloudflare, source storage, Google Drive, the Google integration, and any domain. Use business-controlled administrators and recovery contacts.
- [ ] Resolve the production URL. Access supports a workers.dev address, but Cloudflare recommends a custom domain or route for production. Record the chosen route and any cost before finalizing the sales offer.
- [ ] Define acceptance, setup support, defect warranty, future maintenance responsibilities, and exclusions.
- [ ] Record the proposed outage procedure for review against the supplied Kumon requirements.

Deliver a short scope schedule attached to the purchase agreement. Include the supported device/browser versions and the source format covered by initial import assistance.

## 1. Prove Cloudflare feasibility

Build an isolated vertical slice before porting the full application. It must include Access sign-in, an enrolled kiosk interaction, a student lookup, arrival, departure, an attendance report, and a complete backup and restore experiment.

- [ ] Deploy Hono, D1, and the React shell into a test account using the intended free plans.
- [ ] Test whether one Worker serving static assets and the API simplifies authentication and installation compared with separate Pages and Workers deployments.
- [ ] Translate the minimum schema and attendance transaction. Test simultaneous arrival/departure requests, repeated requests, and a network response lost after a successful commit.
- [ ] Measure Access JWT verification, secure kiosk PIN verification, and backup encryption against Workers execution limits. Do not weaken security controls to pass the free-tier test.
- [ ] Replace full-history polling with current-roster requests, bounded updates, and paginated history. Pause unnecessary refreshes when the application is hidden or locked.
- [ ] Generate representative two-year and growth datasets in the test environment. Include guardians, schedules, corrections, audit records, indexes, and realistic notes, not only attendance rows.
- [ ] Measure the declared number of students, operating days, active devices, open-browser hours, attendance actions, report runs, imports, and backup activity.
- [ ] Test sustained normal activity and operational peaks. Record rows read, rows written, Worker requests, CPU time, database storage, export size, and Google Drive storage.
- [ ] Exercise quota exhaustion and failed dependencies. Show an actionable error without confirming an unsaved attendance event.
- [ ] Document every external dependency and whether it requires payment, a payment method, customer credentials, or periodic renewal.

Current reference limits to recheck at release are 50 Cloudflare Access users per account, 100,000 Worker requests daily, 10 milliseconds of CPU per free Worker invocation including cron invocations, 5 million D1 row reads daily, 100,000 D1 row writes daily, and 500 MB per free D1 database. D1 Free currently provides seven days of point-in-time recovery. These are provider limits, not measured application capacity.

The recommended capacity criterion is that the declared normal workload consumes no more than half of daily request, read, and write allowances, with a demonstrated margin for peaks and growth. This is a proposed engineering target, not a customer promise. CPU and storage must also pass their individual limits. Include all workloads sharing the customer's account.

Exit gate: publish a measured supported workload and an explicit pass or fail for every required free service. If secure authentication, backup processing, or storage fails, resolve the design or revise the commercial scope before promising zero required hosting charges.

## 2. Complete identity and kiosk access

Use Cloudflare Access for back-office identity. Keep application roles, center scope, and administrative audit records inside the CRM.

- [ ] Configure exact permitted identities and roles. Avoid granting access merely because an email shares a broad domain.
- [ ] Use the customer's chosen identity provider with MFA enforced. Cloudflare email one-time codes can be considered where appropriate, but an emailed code alone must not be described as two independent factors.
- [ ] Validate JWT signature, issuer, audience, and expiry in the Worker. Protect direct API and alternate deployment addresses from bypassing Access.
- [ ] Implement owner-managed access, role changes, deactivation, recovery instructions, and protection against removing the last usable owner.
- [ ] Distinguish removing an Access seat from revoking permission to authenticate. Deprovision both application access and the relevant identity policy.
- [ ] Display account seat usage or provide a documented owner check. Users across several installations can share the same account allowance.
- [ ] Enroll kiosks through an authenticated owner action. Issue a restricted, revocable device credential with an appropriate expiry and renewal process.
- [ ] Require an individual staff PIN within an enrolled kiosk. Add attempt limits, inactivity locking, reset procedures, and staff attribution on every action.
- [ ] Restrict kiosk routes and responses to the necessary attendance workflow. Exclude owner settings, bulk exports, unrestricted notes, and other back-office operations.
- [ ] Keep account API tokens and broadly privileged Access service secrets out of browser JavaScript.
- [ ] Test lost-device revocation, PIN guessing, stale sessions, staff deactivation, privilege escalation, and concurrent users.

Kiosk PIN verification is a limited custom security component. It does not replace the managed identity provider for owners, and a shared PIN is not sufficient attribution for named staff actions.

## 3. Port core CRM and attendance

- [ ] Add versioned D1 schema migrations and a documented migration ledger.
- [ ] Translate PostgreSQL-specific types, queries, locking, and transaction behavior. Preserve atomic attendance decisions using D1-supported mechanisms.
- [ ] Preserve stable request IDs and payload checks. A repeated request must return the original result, and reuse of an ID for changed content must fail.
- [ ] Preserve immutable original attendance observations, corrections, staff attribution, and separate observation/receipt times where relevant.
- [ ] Preserve actual-departure recording separately from release authorization. Missing or uncertain pickup authority must not become permission by default.
- [ ] Preserve inactive students with open visits, unresolved-presence indicators, and reports that distinguish verified from review-needed attendance.
- [ ] Port students, guardian relationships, inquiries, recurring schedules, tasks, interactions, reports, and exports within the agreed scope.
- [ ] Make center name, time zone, hours, and other supported setup fields editable by the owner.
- [ ] Keep schedules from generating attendance and historical records from creating false current presence.
- [ ] Run meaningful regression tests against D1 behavior, including real deployed concurrency and time-zone boundaries.

Do not migrate or change the Railway installation as part of a feasibility experiment. Any later cutover gets a separate, explicit procedure after the Cloudflare version passes acceptance.

## 4. Deliver bulk CSV roster import

The first importer accepts a documented template and supports explicit column mapping. Do not promise compatibility with a Kumon export that has not been supplied.

- [ ] Define supported fields, required student identity, guardian relationships, subjects, and explicit pickup-authority states.
- [ ] Parse with file-size and row-count limits appropriate to the free execution budget.
- [ ] Preview proposed creates, updates, rejected rows, and unresolved duplicates before committing.
- [ ] Detect duplicates using stable references and reviewed matches. Never merge students solely because their names match.
- [ ] Keep missing pickup authority unverified. A guardian contact is not automatically an authorized pickup person.
- [ ] Bind the accepted preview to the file and mapping version. Revalidate if relevant records change before commit.
- [ ] Commit in bounded, resumable batches with stable import IDs. Retrying or re-uploading the same batch must not create duplicate records.
- [ ] Produce an import receipt accounting for every row and all resulting students and relationships.
- [ ] Delete temporary source files according to a documented short retention period. Keep customer files out of developer logs and accounts.
- [ ] Test malformed CSV, encoding, missing IDs, duplicate rows, sibling relationships, both subjects, unauthorized access, and interruption during commit.

This is roster import. Historical attendance migration and source-specific connectors remain separately scoped until actual source data and timestamps are understood.

## 5. Complete backup, restoration, and the outage procedure

### Backup and independent recovery

- [ ] Verify D1 Time Travel availability and demonstrate a restore within its supported window.
- [ ] Schedule consistent nightly exports outside operating hours. Native D1 export blocks other database requests while running, so measure the duration and define operator handling.
- [ ] Implement the Google Drive connection using customer-controlled authorization. Avoid a dependency on our Google Cloud project or secrets if complete independent operation is part of the sale.
- [ ] Validate Google consent and token behavior for the buyer's actual account type. Do not ship a Google OAuth integration left in external Testing mode with seven-day refresh-token expiry.
- [ ] Encrypt backups and provide customer-controlled recovery keys separately from the backup files. Recovery must remain possible if the original Cloudflare account is unavailable.
- [ ] Include a manifest with schema version, application version, export time, record counts, and a checksum. Transfer credentials through the agreed secure channel, not through plaintext backup manifests.
- [ ] Verify upload completion and record backup success only after verification. Retry transient failures and notify the owner of stale or failed backups through a validated delivery mechanism.
- [ ] Select bounded daily, weekly, and monthly rotation after measuring export sizes and available Drive storage. Document who receives capacity warnings.
- [ ] Recover an older backup into a separate installation. Compare record identities, relationships, attendance times, corrections, history coverage, and checksums where applicable.
- [ ] Test restoration into a fresh customer-controlled account using the delivered source package and keys, without our account or deployment access.
- [ ] Revoke or reissue restored sessions and device credentials, reapply later access revocations, and handle retention holds and deletion decisions before reopening access.
- [ ] Identify the interval after the restored backup. Reconcile any available records from that interval; do not silently assume previously acknowledged activity survived.
- [ ] Measure total recovery time and report any unrecoverable interval. Document the owner's steps and escalation path.

Nightly independent backups expose up to roughly 24 hours of subsequent changes when the latest scheduled backup succeeded, and longer if failures go unresolved. D1's seven-day recovery window and the two-year attendance retention requirement serve different purposes. Establish acceptable recovery objectives with the buyer before promising them in the agreement.

### v1 connection behavior and contingency

- [ ] Show connection state and the last successful data refresh. Mark displayed presence as potentially stale while disconnected.
- [ ] Confirm attendance only after the server acknowledges the write. On an uncertain response, resolve the existing request ID before creating another observation.
- [ ] Retry reads safely and bound retry frequency. Do not add an undisclosed durable offline write queue to v1.
- [ ] Draft a center procedure for unavailable Wi-Fi, internet, Access, or the application. Distinguish a fresh observation from later reconciliation of a contemporaneous contingency record.
- [ ] Specify how staff verify physical presence and obtain the minimum needed attendance information during the outage. An encrypted backup in Drive is not automatically a usable emergency roster.
- [ ] Rehearse the procedure with staff and record the result. Obtain the appropriate Kumon or center confirmation that the proposed fallback satisfies the applicable requirement.

The supplied document requires access to check-in information when the primary system is unavailable. A retry banner and nightly backup alone do not close this requirement. If the agreed fallback does not satisfy it, disclose the gap and adjust the release scope before operational acceptance. Do not label the center fully compliant merely because offline synchronization was deferred.

## 6. Retention and the eight-requirement report

- [ ] Retain at least two years of attendance with the student identity, corrections, and attribution needed to understand it.
- [ ] Prevent routine student deactivation or deletion from removing protected attendance evidence.
- [ ] Record the center's retention policy, applicable holds, and authority to approve disposition.
- [ ] Provide a retention review report. Defer automatic purge until the policy and handling of linked records and backups are approved and tested.
- [ ] Do not delete data exactly at two years merely to remain inside free storage limits. Publish capacity limits and provide export or upgrade options before storage exhaustion.
- [ ] Generate a dated readiness report identifying the application version, center, evidence, unresolved items, and responsible reviewer.

| Supplied requirement | Report evidence | Acceptance owner |
| --- | --- | --- |
| 1. Digital system | Installed version and demonstrated digital attendance workflow | Engineering and center |
| 2. Unique student identification | Stable IDs, duplicate controls, and import reconciliation | Engineering |
| 3. Actual arrival and departure | Observed event times, attribution, correction history, and contingency handling | Engineering and center |
| 4. Staff oversight and training | Named access, operating procedure, staff demonstration, and training attestation | Center |
| 5. Current student awareness | Current-presence view, historical lookup, stale-state handling, and outage procedure | Engineering and center |
| 6. Backup or preservation approach | Backup verification, restore evidence, recovery access, and accepted contingency procedure | Engineering and center |
| 7. Appropriate PII handling | Limited data collection, role/kiosk restrictions, controlled exports, and access handover | Engineering and center |
| 8. Reviewable records retained at least two years | History/export checks, linked-record preservation, and retention policy | Engineering and center |

Use statuses such as demonstrated, awaiting center attestation, and unresolved. Do not automatically generate a certification. The source document makes its annual certification language conditional on finalized and implemented requirements.

## 7. Package installation, updates, and handover

- [ ] Deliver one maintained source codebase and versioned releases. Keep customer configuration and secrets separate from source.
- [ ] Build a resumable installer that provisions the Worker, D1, migrations, Access configuration, backup job, and health checks.
- [ ] Use customer-controlled accounts with named administrators and MFA. Use scoped temporary installation access rather than exchanging shared account passwords.
- [ ] Provide an owner setup flow for center settings, staff permissions, kiosk enrollment, and the Google Drive connection.
- [ ] Keep every new installation empty. Use an isolated test procedure for acceptance records and document any cleanup.
- [ ] Deliver source, dependency licenses, release notes, build instructions, deployment configuration, account inventory, recovery runbook, and operating guides.
- [ ] Store account recovery information and backup keys through an agreed secure customer-controlled process.
- [ ] Test an update with versioned schema changes, a pre-update backup, and a compatible recovery procedure. Do not assume reverting application code also reverses a database migration.
- [ ] Remove our deployment, data, and backup access after acceptance unless a separate support arrangement explicitly retains a restricted role.
- [ ] Confirm the software continues functioning after our access is removed. Avoid mandatory vendor telemetry or a vendor-owned licensing service.
- [ ] Time a complete installation with a person following only the runbook. Treat the proposed 20-minute onboarding call as a measured product goal, not an existing capability.

## 8. Pilot, written acceptance, and commercial terms

Run a pilot in an isolated installation, then use the agreed operational acceptance process for the first center. Do not promise all eight requirements are met while an unresolved outage, data, or access issue remains.

The acceptance record should include the buyer and center, release version, agreed scope, supported workload, test results, unresolved minor items, account ownership, delivery date, and written customer acceptance.

| Gate | Pass condition |
| --- | --- |
| Ownership | Buyer controls application, database, source, backup destination, keys, and administrator recovery |
| Access | Owner and kiosk workflows pass; unauthorized users, devices, and centers cannot access records |
| Attendance | Actual observations, uncertain-response retries, pickup restrictions, corrections, and current presence behave as agreed |
| Import | Every source row has a disposition and retries create no duplicates |
| Retention | Two-year records remain reviewable with linked evidence; routine actions cannot remove protected history |
| Recovery | Native recovery and independent backup restoration pass with measured recovery time and a documented data gap |
| Outage handling | Staff demonstrate the agreed fallback; any requirement exception is explicitly recorded by the appropriate reviewer |
| Free allowances | Published workload passes measured limits with the agreed headroom and no undisclosed paid dependency |
| Installation and update | Another maintainer can install and update from the delivered package |
| Handover | Temporary supplier access is removed and the installation continues operating |

Proposed support terms are 30 days of setup support beginning on written acceptance. Define a defect warranty separately, even if it uses the same window. A defect reported within the warranty window remains covered until resolved under the agreement; it should not become chargeable merely because the repair finishes later.

Define severity, response expectations, exclusions, customer responsibilities, and the handling of changed third-party services. Acceptance starts the agreed support period and completes listed installation duties. It does not automatically remove other contractual or statutory obligations.

The agreement should identify the franchisee's role in deciding how student data is used and the supplier's permitted temporary activities during installation or support. Hosting in the customer's account does not alone establish that the supplier never processes personal data. Include confidentiality, access limits, temporary-copy deletion, provider responsibilities, and post-handover access removal. Adapt the controller, processor, or service-provider terms to the applicable jurisdiction and actual arrangement.

## Release exclusions

- Durable offline attendance capture, automatic offline synchronization, and conflict resolution across independently offline devices.
- A centrally hosted platform containing several independently owned franchisees' data.
- Multi-location dashboards and center switching unless added to the signed v1 scope.
- Custom Kumon connectors and historical migration before source formats and scope are agreed.
- Automatic deletion at the two-year anniversary.
- Mandatory subscriptions, remote license shutdown, or renewal requirements for purchased features.
- Indefinite support, guaranteed provider pricing, or an unmeasured promise of zero costs forever.

## First implementation assignment

Complete milestones 0 and 1 first. The first engineering deliverable is an isolated Cloudflare installation demonstrating Access, a restricted kiosk action, D1 attendance integrity, bounded data loading, and a Google Drive backup that can be restored independently. Deliver the measurements and a pass/fail decision before scheduling the full migration.

## References

Provider documentation was reviewed on September 14, 2026. Recheck limits, pricing, and account setup requirements before release and during customer installation.

- [Cloudflare Access plans](https://www.cloudflare.com/sase/products/access/)
- [Cloudflare One seat management](https://developers.cloudflare.com/cloudflare-one/team-and-resources/users/seat-management/)
- [Cloudflare Access email one-time codes](https://developers.cloudflare.com/cloudflare-one/identity/one-time-pin/)
- [Access JWT validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)
- [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [Workers execution limits](https://developers.cloudflare.com/workers/platform/limits/)
- [workers.dev routing and production guidance](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/)
- [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)
- [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)
- [D1 import and export](https://developers.cloudflare.com/d1/best-practices/import-export-data/)
- [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)
- [Google OAuth token expiration](https://developers.google.com/identity/protocols/oauth2)
- [Google Drive API limits](https://developers.google.com/workspace/drive/api/guides/limits)
- [Cloudflare terms](https://www.cloudflare.com/terms/)
- [Extracted supplied Kumon requirements](../research/provided_source.txt)

Related repository documents describe the existing implementation and earlier delivery proposals. They may retain Railway or broader offline scope. This standalone plan records the Cloudflare v1 proposal from this discussion; it does not silently rewrite those documents or report their implementation as complete.
