# Kumon center CRM business requirements document

Version 0.1 | 14 September 2026 | Draft for owner and stakeholder review

Prepared for the Kumon center owner, center manager, instructors, operations staff, and delivery team.

## Purpose and recommendation

Build an in-house customer relationship management system that brings inquiry follow-up, student and family records, enrollment, scheduling, and daily attendance into one staff workspace. Make trustworthy attendance the first release gate. Add family-facing services and financial integrations after the center can demonstrate that arrival, departure, record retrieval, and outage procedures work under real operating conditions.

The supplied two-page document establishes eight baseline attendance requirements. It does not specify a full CRM, select a technology stack, approve a vendor, or confirm a final policy effective date. This BRD turns that evidence into business requirements and adds clearly labeled proposals for the broader CRM requested by the owner. [SRC01]

The Business Requirements Document explains why the system is needed and what belongs in scope. The companion Functional Requirements Document defines testable behavior. The Functional Design Report proposes how to implement it. FDR is interpreted as Functional Design Report, subject to the owner's terminology.

## Evidence and working assumptions

Evidence labels apply throughout this package. Source requirements come directly from the attachment. Research findings come from official vendor or government pages reviewed on 14 September 2026. Proposed requirements are design recommendations. Assumptions make the draft concrete and need confirmation before commitment.

| ID | Working assumption | Effect on the draft |
| --- | --- | --- |
| A01 | One independently operated Kumon center launches first | All records carry a center ID; multi-center administration is deferred |
| A02 | Staff operate the first release on managed computers and tablets | No child account or self-service parent portal is required for launch |
| A03 | Up to 500 active students, 50 simultaneous staff or device sessions, and a burst of 30 arrival events in five minutes | These are proposed test loads, not observed center volumes |
| A04 | The center's country, state or province, privacy obligations, and hosting restrictions are unknown | The owner must resolve jurisdiction and data policy before using live student records |
| A05 | Existing data, Kumon corporate systems, and permitted interfaces have not been supplied | Imports use approved files; no corporate API or migration access is assumed |
| A06 | Budget, staffing, delivery date, and support coverage are unconfirmed | The roadmap uses acceptance gates rather than promised dates |
| A07 | Attendance is required across a student's center visit | A visit can span more than one subject without creating a false departure |

The current workflow, time spent on administration, missed follow-ups, and record quality have not been observed. Claims about savings or current deficiencies would be premature. Discovery should include an arrival period, a departure period, an inquiry-to-enrollment walkthrough, and a sample of existing records.

## Business problem and intended outcomes

The center needs an operating record that staff can use while students are present and managers can review later. CRM records should connect the family relationship with the student's enrollment and visits, while keeping attendance usable if marketing or billing services fail.

| ID | Business requirement | Basis | Evidence of success |
| --- | --- | --- | --- |
| BR01 | Record actual arrivals and departures digitally with a stable student identity | Source items 1 to 3 | Every observed pilot transition has a corresponding event or a documented exception |
| BR02 | Give staff a current roster and retrievable attendance history | Source item 5 | Staff identify who is present and retrieve a selected historical visit during a drill |
| BR03 | Preserve attendance and access during a primary-system outage | Source item 6 | Staff complete an outage and recovery drill without silently losing events |
| BR04 | Protect necessary student data and retain reviewable attendance for at least two years | Source items 7 and 8 | Access tests, retention boundary tests, and a historical export pass |
| BR05 | Establish trained staff ownership and evidence for future review | Source item 4 and conditional annual review statement | All scheduled launch staff complete training; manager can assemble evidence |
| BR06 | Track inquiries, assessments, enrollment decisions, and follow-up ownership | Proposed CRM scope | Each open inquiry has an owner, status, and next action or documented exception |
| BR07 | Maintain connected student, guardian, household, enrollment, and schedule records | Proposed CRM scope | Staff can find the correct student and permitted contact without duplicate active identities |
| BR08 | Record family interactions and respect contact preferences | Proposed CRM scope | Contact history is attributable and visible to authorized staff; sending remains deferred |
| BR09 | Give the owner consistent operational reports | Proposed CRM scope | Attendance and funnel totals reconcile to their underlying records |
| BR10 | Make the system maintainable and the center's data portable | Proposed operating requirement | A second maintainer can deploy, restore, and export using documented procedures |
| BR11 | Permit later family services and approved integrations | Proposed expansion | Defined interfaces exist without making launch dependent on external systems |

Proposed launch targets are 100 percent trained launch staff, zero unexplained event loss in test and pilot, no unresolved critical access defects, and zero open attendance discrepancies at final pilot sign-off. Normal attendance actions should respond within two seconds at the 95th percentile and update online rosters within five seconds. The FRD defines the test conditions.

Measure the observed capture rate as recorded arrivals and departures divided by independently observed arrivals and departures during sampled pilot periods. Exception logging does not count as a completed capture until reconciled. Measure inquiry conversion by inquiry cohort, using converted inquiries divided by eligible inquiries in that cohort, and show the cohort period. Do not infer conversion from unrelated monthly totals.

After two weeks of discovery or pilot measurement, the owner can set follow-up and administration-time targets. The package makes no revenue, retention, or labor-saving forecast.

## Scope and release boundaries

| Release | Included capability | Exit condition |
| --- | --- | --- |
| Discovery | Validate policy version, center workflow, jurisdiction, data ownership, device use, volume, migration, and support model | Owner resolves release-blocking decisions and approves the baseline |
| First release | Staff authentication, roles, students and families, leads and tasks, enrollment, recurring schedules, attendance, live roster, historical reports, corrections, contingency capture, retention, backups, training, audit, and manual communication history | All first-release requirements and operational drills pass |
| Second release | Approved parent messaging, restricted guardian portal, external payment linkage, and simple instructor progress summaries | Separate consent, authorization, and provider-specific acceptance pass |
| Later | Corporate interfaces if authorized, multi-center administration, advanced analytics, and additional workflow automation | Business value and integration access justify each addition |

The first release does not replace Kumon curriculum, assessment methods, learning materials, corporate student systems, accounting, payroll, or statutory reporting. A staff-recorded assessment appointment and outcome support enrollment; they do not reproduce proprietary assessments. No biometric identification, public student directory, student advertising, or automated educational decision-making is proposed.

Staff can record that a payment was discussed or that an external system holds the billing record. The first release does not store card numbers or process funds. Math and reading are configurable enrollment subjects; the system does not claim authority over any corporate academic record.

## Source requirements translated into business obligations

| Source item | Baseline stated in the supplied PDF | Required business response |
| --- | --- | --- |
| 1 | Digital system is the baseline; manual logs, paper, or Excel-only tracking are not the baseline | Use a digital attendance service during normal operations |
| 2 | Each student is uniquely identifiable | Maintain a stable internal student identifier and resolve name collisions |
| 3 | Entries reflect actual arrival and departure, rather than later recordkeeping | Capture at the event; preserve actual time separately from later receipt or correction |
| 4 | Staff understand and consistently follow the process | Assign oversight and train staff on normal and exception workflows |
| 5 | Staff can determine who is present and access history | Provide a current roster, explicit stale-data indicators, and historical retrieval |
| 6 | Reasonable preservation and access approach if the primary system is unavailable | Fund backup, contingency access, and a practiced recovery process |
| 7 | Protect and limit student information to what the workflow reasonably needs | Restrict attendance views and separate broader CRM data by role and purpose |
| 8 | Retain reviewable attendance for at least two years | Enforce a retention floor and preserve identity links needed to interpret records |

All eight items are taken from page 1 of SRC01. The attachment also says annual certification will be expected once requirements are finalized and implemented, and centers may be asked to demonstrate the system. The policy's final version, effective date, required certification format, and submission route remain open. The design supports readiness evidence without claiming that a particular certification is already due.

## Stakeholders and daily workflows

| Role | Responsibility | Decisions or evidence needed |
| --- | --- | --- |
| Center owner | Business sponsor and accountable data owner | Scope, budget, risk acceptance, jurisdiction, support funding, final release decision |
| Center manager | Daily operations and attendance owner | Pickup rules, end-of-day review, corrections, training and outage drills |
| Front desk staff | Inquiry follow-up and supervised arrival and departure | Usable screens, clear exception escalation, permitted contact access |
| Instructor | Student awareness and permitted notes | Student roster, enrollment context, limited operational notes |
| Guardian | Supplies contact and authorization information | Accurate relationship records, contact preferences, later portal expectations |
| Technical maintainer | Delivery, access controls, backups and incident response | Named support coverage, deployment procedures, monitoring and recovery evidence |
| Privacy or legal adviser | Applicable law and record policy review | Location, data flows, retention schedule, contracts and notices |
| Kumon representative if required | Confirms current organizational requirements | Current checklist, review expectations and integration permissions |

An inquiry becomes a lead with a responsible staff member and a next action. An assessment or orientation appointment records attendance and a staff-entered outcome. Conversion creates or links a student and household, activates enrollment, and assigns a schedule. The staff member checks for an existing family before creating a duplicate.

At arrival, staff identify the student and record an explicit check-in. The roster displays the student as present after the event is saved. At departure, staff follow the center's approved release procedure, record an explicit check-out, and resolve any authorization concern before release. A QR code can identify a record; it does not prove custody or grant pickup authority.

The manager reviews unresolved visits and corrections each day. A missing check-out produces a discrepancy requiring a factual correction or continued investigation. The system never invents a departure time based on the schedule or closing time.

During an outage, the manager designates one contingency station and takes operational control of the local roster. Other stations direct staff to it. A protected local record and encrypted event queue preserve current observations. A total device or power failure uses the approved emergency procedure, which can include a contemporaneous temporary paper record if needed. That is an emergency exception, subject to confirmation of the current policy, and not the regular attendance method.

## Vendor research and implications for building

The attachment lists ten vendors as research starting points and expressly says the list is not a Kumon endorsement. Official public pages were reviewed for all ten. The following appendix records the verified public claims and exact sources. Public documentation does not prove that a selected plan meets the center's requirements, retains two years of data, works offline, or offers an integration API. Those details require specific evidence. [SRC01, V01 to V10]

Across the reviewed products, recurring patterns include student identification, staff attendance views, guardian check-in options, reporting, and links to enrollment or billing. The useful lesson for an in-house system is the workflow pattern, not the full childcare product scope. Childcare ratios, meal programs, payroll, and classroom media feeds are not first-release CRM requirements here.

Attendance alone is unlikely to justify a custom build on subscription savings. The PDF's illustrative $25 to $75 per month range equals $300 to $900 a year before add-ons, and is neither a quote nor a verified market range. A custom system brings engineering, security, device management, support, backup, and continuity costs. The stronger business case is a proven need for one center-specific inquiry-to-enrollment-to-attendance workflow that existing tools cannot serve affordably. [SRC01 p2]

| Option | Business advantage | Cost or constraint | Decision use |
| --- | --- | --- | --- |
| Buy attendance software | Potentially faster implementation and established support | Fit, retention, exports, outages, and recurring fees need verification | Fallback if attendance is urgent |
| Build CRM and integrate purchased attendance | Custom relationship workflow with less attendance code | Requires a permitted and adequate API or reconciliation process | Consider only after interface evidence exists |
| Build the complete scoped first release | Direct control of workflow, data model and reporting | Center funds all software and operational responsibilities | Recommended drafting basis because the owner requested in-house CRM |

Use a three-year total-cost comparison before funding. Custom cost equals discovery plus design plus implementation plus migration plus testing plus devices, then three years of hosting, authentication, messaging if added, monitoring, maintenance, support, and security review. Vendor cost equals setup and migration plus devices plus 36 months of the actual plan and add-ons, then integration and exit costs. Engineering estimates and vendor quotes remain to be obtained.

## Privacy and data stewardship

The attendance baseline requires limited and protected student information. The broader CRM adds different purposes, including inquiries, guardian contact, and enrollment. Each field needs a purpose and an access rule. Do not copy every available field into the attendance kiosk or backup roster.

The design assumes staff accounts and staff-supervised identification at launch. Collecting data about children does not, by itself, determine every law that applies. The FTC describes COPPA as applying to certain commercial websites and online services directed to children under 13 and to certain services with actual knowledge of relevant collection. A parent portal, child-facing kiosk, identifier, or future app requires an applicability review based on its actual data flows. [REG01]

FERPA generally applies to educational agencies or institutions receiving funds under programs administered by the US Department of Education. Its official guidance says private elementary and secondary schools generally do not receive such funding. Do not assume that a Kumon center is automatically covered or exempt without reviewing its circumstances and agreements. [REG02]

If the center operates in Canada or another jurisdiction, review the applicable national and provincial or local rules, data residency expectations, consent, access rights, breach response, and contractual requirements before production. The user's location and legal entity have not been supplied.

## Risks and dependencies

| Risk | Consequence | Planned control and accountable role |
| --- | --- | --- |
| Checklist is revised or not yet effective | Rework or invalid readiness claim | Owner obtains the current requirements and records policy version |
| Unclear pickup or independent departure rules | Staff release decisions vary | Manager approves written rules and staff escalation before launch |
| Multiple offline stations diverge | Local rosters disagree | One designated contingency authority with explicit reconciliation |
| Corrections overwrite originals | History loses credibility | Append-only events with attributed correction records |
| A developer is the only maintainer | Center cannot recover or patch | Owner names a backup maintainer and tests the runbook |
| Catastrophic recovery restores an older recovery point | Up to 15 minutes of accepted server events may need reconstruction under the proposed target | Owner accepts the explicit recovery limit or funds stronger event preservation; manager records unresolved facts honestly |
| Migration confuses siblings or identical names | Attendance attaches to the wrong student | Stable IDs, dry run, manager review and control totals |
| Automatic deletion breaks two-year history | Reviewable records become incomplete | Retention floor, identity preservation, holds and deletion audit |
| Corporate interface is unavailable | Scope or schedule expands | Approved file exchange at launch; no dependency on an assumed API |
| Scope expands into curriculum or billing | First release becomes harder to validate | Release boundaries and change control |

## Delivery gates and business acceptance

Discovery ends when the owner approves the workflow, policy version, data inventory, support owner, and first-release boundary. Design approval requires walkthroughs with the manager and frontline staff, an agreed data model, and a written outage procedure.

Build acceptance requires all first-release FRD requirements to pass, with evidence retained against their IDs. Before pilot, import a reviewed dataset, test access separation, restore a backup, and rehearse offline and total-power-failure scenarios. Use synthetic data until the location, hosting, and data policy decisions are resolved.

Pilot for at least five representative operating days, including a busy arrival period, a busy departure period, a same-day re-entry, and a controlled outage. The proposed duration is a planning assumption. The manager reconciles each day and independently observes sample transitions. Any critical data-loss, student-misidentification, release-authorization, or access defect blocks launch until corrected and retested.

The owner signs off business scope and operating cost; the manager signs off workflows and training; the technical lead signs off security, recovery, monitoring, and migration; the designated privacy reviewer resolves applicability and policy decisions. Record names, dates, requirement version, exceptions, and supporting evidence. These sign-offs are future project gates, not approvals already obtained.

## Decisions needed before implementation

| ID | Decision | Owner | Needed by |
| --- | --- | --- | --- |
| D01 | Confirm FDR terminology, number of centers, and legal entity | Owner | Scope baseline |
| D02 | Obtain final Kumon checklist, effective date, review and certification process | Owner | Requirements approval |
| D03 | Confirm jurisdiction, notices, hosting region, retention beyond the minimum, and rights process | Owner with privacy adviser | Live-data use |
| D04 | Inventory current CRM, corporate records, data exports, and permitted integrations | Manager and technical lead | Migration design |
| D05 | Approve guardian authorization, independent departure, custody restrictions, and escalation policy | Manager with owner | Attendance pilot |
| D06 | Confirm schedules, peak volumes, devices, connectivity, and contingency location | Manager | Capacity and outage design |
| D07 | Set budget, delivery resources, support coverage, and build versus buy threshold | Owner | Funding |
| D08 | Choose hosting and identity services, accept or improve the proposed recovery loss window, and name primary and backup maintainers | Technical lead and owner | Infrastructure build |
| D09 | Approve first-release CRM fields, lead stages, and report definitions | Manager | Detailed design |
| D10 | Decide which second-release services merit separate requirements and vendor review | Owner | Second-release planning |

Changes to a source requirement, retention rule, custody workflow, or release boundary require an impact review across BRD, FRD, FDR, tests, training, and migration. Record the request, reason, affected IDs, cost or timing effect, decision owner, and approved version.

## Research appendix

The detailed vendor findings and source register follow. Citations describe public material, not a tested product evaluation. No vendor was contacted and no pricing quote was requested.

### V01 Lillio

Lillio describes contactless check-in/out, individual or group check-in, a current attendance view, optional parent signatures, and printable attendance records. Its attendance page explicitly describes timestamped offline check-in that synchronizes after connectivity returns. The FAQ states that information is backed up daily and that records remain accessible when a child becomes inactive. These capabilities support a design that separates event time from synchronization time and keeps former students' records reviewable. Lillio's parent "ready for pickup" message is also a useful distinction: pickup intent must remain separate from an actual departure. Public evidence does not establish a contractual two-year retention commitment, offline checkout, or synchronization conflict handling. [V01a, V01b]

- V01a. [Attendance tracking](https://www.lillio.com/features/attendance-tracking)
- V01b. [Frequently asked questions](https://www.lillio.com/faq)

### V02 Digital Childcare

Digital Childcare describes digital check-in/out, instant attendance updates, monthly attendance reports, parent notifications, and oversight across classrooms and locations. Its Safe Arrival feature can notify a parent when staff mark an unexpected absence. The attendance page describes use on internet-connected tablets, smartphones, and desktops. For the in-house CRM, this supports keeping scheduled visits separate from actual presence and using unexplained absences to create a staff follow-up task. The product targets Canadian childcare operations, so its regulatory features should not become assumed Kumon obligations. Public pages do not establish offline capture, a two-year retention guarantee, or recovery objectives. Paid plans require a quote; the published free tier covers only zero to five children. [V02a, V02b]

- V02a. [Attendance software](https://mydigitalchildcare.com/solutions/childcare-attendance-software/)
- V02b. [Pricing](https://mydigitalchildcare.com/pricing/)

### V03 Procare

Procare describes contactless check-in/out, authorized pickup information, current attendance, unscheduled visits, and prebuilt or custom attendance reports. Its broader management workflow connects prospective families, inquiries, enrollment, registration, waitlists, and lead-source tracking. The security page describes staff roles, permissions, multifactor authentication, and geographic redundancy. For the proposed CRM, the useful pattern is one connected family and student record across inquiry, enrollment, scheduling, and attendance, with access limited by role. Attendance continuity still needs its own tested operating procedure. Public evidence does not establish the selected plan's offline behavior, two-year attendance retention, or complete export format. General-center pricing requires a quote; a separate home-version offer should not be used as Kumon-center pricing. [V03a, V03b, V03c]

- V03a. [Child care management features](https://www.procaresoftware.com/capabilities/child-care-management-software/)
- V03b. [Security controls](https://www.procaresoftware.com/trust-security-compliance/security/)
- V03c. [Request pricing](https://www.procaresoftware.com/request-pricing/)

### V04 brightwheel

brightwheel describes student and staff check-in/out by scan or code, room moves, absence marking, attendance reports, and corrections to current or historical records. Its security FAQ describes encryption in transit and at rest, US-hosted application data and backups, and access to program records through download or request. For the in-house design, its correction workflow highlights the need to preserve original values, amendment reasons, staff identity, and amendment time. A corrected historical record must remain distinguishable from an event captured during arrival or departure. The FAQ states that no single published deletion timeline applies universally, so it does not establish a two-year retention commitment. Offline behavior remains unverified, and subscription pricing is customized. [V04a, V04b, V04c]

- V04a. [Attendance tracking](https://mybrightwheel.com/child-care-attendance-tracking/)
- V04b. [Security FAQs](https://help.mybrightwheel.com/en/articles/6363539-brightwheel-security-faqs)
- V04c. [Pricing](https://mybrightwheel.com/pricing/)

### V05 KidCheck

KidCheck describes staff roster check-in/out, attendance logs, date-range report exports, and a live list of checked-in children. Its Admin Console includes guardian authorization information and mobile roster access for evacuation or fire drills. These features support a fast staff roster and a separate emergency view with a visible capture time. Group check-in should apply only to children staff physically observe arriving together; a student's identifier must not grant pickup authority. Published monthly prices are $25, $45, or $60 for one device, with additional charges for unlimited devices. The page does not explicitly state currency. Public evidence does not establish offline emergency access, a two-year retention commitment, or recovery objectives. [V05a, V05b, V05c, V05d]

- V05a. [Attendance and reporting](https://www.kidcheck.com/childrens-check-in-attendance-and-reporting)
- V05b. [Roster check-in](https://www.kidcheck.com/feature/roster)
- V05c. [Admin console](https://www.kidcheck.com/feature/admin-console/)
- V05d. [Pricing](https://www.kidcheck.com/features-pricing/pricing/)

### V06 Playground

Playground documents QR/PIN kiosk entry, staff and family check-in/out, timestamp and signer attribution, current attendance status, child history, and printed/exported reports. Administrators can add, edit, and delete records. Its API page advertises lead capture, synchronization, dashboards, and billing exports, but specific attendance endpoints and access terms were not verified. These features support a shared student record across enrollment and attendance, with a locked kiosk and a staff presence view. The proposed CRM should preserve original events and correction history rather than permit untracked deletion. Two-year attendance retention, center-side offline recording, offline roster access, and current pricing remain unverified. [V06a, V06b, V06c]

- V06a. [Attendance overview](https://help.tryplayground.com/en/articles/16111397-attendance-overview)
- V06b. [Attendance product](https://www.tryplayground.com/solutions/attendance)
- V06c. [API](https://www.tryplayground.com/solutions/api)

### V07 Famly

Famly publishes PIN and QR entry, expected versus actual attendance, signed-in views, registration forms, lead/waitlist management, and occupancy reporting. Its tablet QR changes every five seconds; a static printed option also exists. Its emergency guide explicitly requires an internet connection to access evacuation information and recommends mobile data or a hotspot. This does not establish offline roster access. Public GraphQL documentation includes check-ins, students, contacts, inquiries, and permission-controlled tokens with expiry. The proposed CRM should separate scheduled attendance from observed presence and test roster access during connectivity loss. Two-year contractual retention and center-side offline event capture were not verified. [V07a, V07b, V07c, V07d]

- V07a. [Enrollment and attendance](https://www.famly.co/us/platform/enrollment-attendance)
- V07b. [QR check-in/out](https://help.famly.co/en-us/articles/8075420-qr-code-check-in-out-screen)
- V07c. [Emergency workflow](https://help.famly.co/en-us/articles/4912356-in-case-of-emergency)
- V07d. [Public API reference](https://docs.famly.co/)

### V08 Daily Connect

Daily Connect documents parent QR or unique PIN sign-in, optional signatures and surveys, current classroom membership, ratio alerts, saved attendance reports, and report exports. Its broader platform includes enrollment forms, waitlists, deposits, billing, and parent communication. The pricing page displayed Professional at $16/month billed annually, including ten children, then $1.60 per additional child; payment-processing fees and center-specific scope require separate confirmation. The proposed CRM can use the same low-friction entry and immediate staff visibility, with optional sign-out notifications that do not delay attendance recording. Two-year retention, center-side offline attendance or roster access, and a supported public attendance API were not verified. [V08a, V08b, V08c]

- V08a. [Attendance](https://en.dailyconnect.com/sign-in-attendance-tracking)
- V08b. [Homepage](https://en.dailyconnect.com/)
- V08c. [Pricing](https://en.dailyconnect.com/pricing)

### V09 Jumbula

Jumbula's Business App distinguishes session attendance, dismissal, and check-in/out. It documents present/late/absent/excused statuses, timestamps, authorized pickup options, guardian/bus/self-dismissal methods, scan-code/PIN entry, kiosk mode, exception notes, reports, and role-based access. Its homepage advertises registration, payments, campaigns, and custom API integration. Vendor-linked API documentation lists families, participants, parents, and authorized pickups, but attendance endpoints and commercial access remain unverified. The design lesson is to model center presence, subject-session participation, and release authorization separately. Moving from math to reading must not create a false departure. Two-year retention, offline event capture/roster access, and immutable correction history were not verified. [V09a, V09b, V09c]

- V09a. [Business App](https://jumbula.com/jb-business-app/)
- V09b. [Homepage](https://jumbula.com/)
- V09c. [Vendor-linked API documentation](https://app.theneo.io/hassan-jumbula-com/jumbula2/getting-started/introduction)

### V10 EZChildTrack

EZChildTrack documents QR, predefined-code, barcode, and card-based attendance, real-time tablet entry, authorized multiple-child pickup, activity attendance, reports, and centralized family/enrollment records. Parents can save a personalized QR page and present it without internet. This verifies offline credential presentation only; it does not establish disconnected center-side event recording or roster access. Its cloud page describes backups and recovery without measurable recovery targets. The proposed CRM should support inexpensive tablets/scanners, create a separate event for each sibling, and test backup restoration and connectivity loss. Two-year contractual retention, center-side offline operation, a supported public API, and numerical pricing remain unverified. [V10a, V10b, V10c, V10d]

- V10a. [Attendance](https://www.ezchildtrack.com/attendance-tracking.html)
- V10b. [Tablet interface](https://www.ezchildtrack.com/ipad-interface.html)
- V10c. [Features](https://www.ezchildtrack.com/features.html)
- V10d. [Cloud storage and backups](https://www.ezchildtrack.com/cloudbased.html)

## Source register

SRC01. User-supplied Student Check-In and Check-Out System Requirements and Non-Exhaustive Informational Vendor List. Undated, two-page PDF, reviewed 14 September 2026. Page 1 contains eight baseline attendance requirements and the conditional future certification statement. Page 2 lists ten illustrative vendors, non-endorsement language, and illustrative pricing. The original attachment remains the reference source.

V01 to V10. Official vendor product, help, pricing and documentation pages listed with each vendor in the research appendix. All were accessed on 14 September 2026. Suffixes such as V01a identify an exact page. The research describes published claims and explicitly identifies unknowns.

REG01. US Federal Trade Commission. Complying with COPPA frequently asked questions. Applicability discussion reviewed 14 September 2026. https://www.ftc.gov/business-guidance/resources/complying-coppa-frequently-asked-questions

REG02. US Department of Education. To which educational agencies or institutions does FERPA apply. Applicability discussion reviewed 14 September 2026. https://studentprivacy.ed.gov/faq/which-educational-agencies-or-institutions-does-ferpa-apply

No corporate Kumon policy portal, franchise agreement, internal student-system documentation, vendor contract, or existing center dataset was supplied. Current policy status, legal applicability, plan-specific capabilities and integration permission remain decisions to confirm.
