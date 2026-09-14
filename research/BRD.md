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

{{VENDOR_APPENDIX}}

## Source register

{{SOURCE_REGISTER}}
