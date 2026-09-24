# Vendor research, group A

Access date for every web source below: September 14, 2026. These are current public statements from official vendor sites. No product was tested, no quote was requested, and no vendor was contacted. A feature described below is a vendor claim, not proof that the product meets Kumon's requirements. The supplied PDF remains the source of the eight check-in/check-out baseline requirements.

## Lillio, formerly HiMama

- **Evidence.** The attendance page describes contactless sign-in/out, automatic attendance recording, real-time attendance views, individual or multiple-child check-in, optional digital parent signatures, pickup notifications, and printing individual attendance records. It explicitly describes offline attendance: the device timestamps each check-in and marks children checked in after connectivity returns and the attendance page reloads. It does not explicitly establish offline checkout or conflict handling. [VA01](https://www.lillio.com/features/attendance-tracking)
- **Preservation and access.** The FAQ says information is backed up daily. Children who leave become inactive, and their profiles, records, and reports remain accessible. The same page says supervisors can see classrooms in real time and central directors can access multiple locations with one login. These are useful statements, but neither a contractual two-year retention commitment nor a recovery-time guarantee is stated. [VA02](https://www.lillio.com/faq)
- **Security.** The Internet Safety page states encryption in transit, encryption at rest, and AWS hosting. These public claims do not substitute for reviewing a security agreement or audit report. [VA03](https://www.lillio.com/internet-safety)
- **Pricing.** The fetched pricing page offers a demo request and contains no numeric subscription price. Do not apply the supplied PDF's illustrative $25-$75 range to Lillio. [VA04](https://www.lillio.com/features/pricing)
- **Design lesson for the in-house system.** Capture the actual event timestamp while disconnected and retain it separately from the server receipt time. Show whether a roster is synchronized and when it was last updated. Parent "ready for pickup" messages must be separate from actual departure events. Staff must confirm that the child physically left before checkout.
- **Still unknown.** Two-year attendance retention and export after contract termination; offline checkout and duplicate/conflict resolution; recovery objectives; export schema; public API and webhooks; plan entitlements and Kumon learning-center fit.

## Digital Childcare

- **Evidence.** The official attendance page describes instant digital check-in/out, automated monthly attendance reports that can be shared with third parties, parent attendance notifications, multiple-classroom and multiple-location oversight from one dashboard, and attendance on internet-connected tablets, smartphones, or desktops. It states that unexpected absence can trigger a push notification asking the parent to confirm the absence. It also describes attendance integration with billing and scheduling. [VA05](https://mydigitalchildcare.com/solutions/childcare-attendance-software/)
- **Fit.** The home page positions the product for Canadian licensed childcare centers, agencies, and providers with several locations. Canadian funding and childcare compliance features are product context, not Kumon requirements. [VA06](https://mydigitalchildcare.com/)
- **Pricing.** The pricing page lists a free Starter plan for 0-5 children. All larger tiers direct visitors to request pricing, beginning with Foundation for 6-29 children. A stale promotional banner on the home page says its offer ended July 31, 2026, so that promotion should not inform a September budget. [VA07](https://mydigitalchildcare.com/pricing/)
- **Design lesson for the in-house system.** Keep scheduled attendance separate from actual presence. Use missed expected visits to create a staff follow-up task, then send parent notifications only under an approved communications policy. Store attendance events once and let authorized reports or later billing workflows consume them.
- **Still unknown.** The reviewed pages do not establish offline event capture, backup or restore behavior, a two-year retention guarantee, correction audit history, export format, API/webhooks, or a numeric paid-plan price. "Compliance-ready" language does not establish compliance with Kumon's requirements or any particular law.

## Procare

- **Evidence.** The child-care-management page describes contactless check-in/out, authorized pickups, up-to-the-minute attendance, unscheduled attendance, prebuilt and custom attendance reports, and consolidated reporting across centers. It also describes a prospective-family workflow from first inquiry to enrollment, targeted communications, online registration, waitlists, and lead-source tracking. These CRM functions are relevant design references for the requested broader system. [VA08](https://www.procaresoftware.com/capabilities/child-care-management-software/)
- **Security and continuity.** The security page states customized roles and permissions, multifactor authentication across Procare platforms, US data centers, geographic redundancy, and business continuity and disaster-recovery processes. The trust page claims SOC 2 Type 2 compliance. No audit report was inspected, and the public statements do not identify the attendance retention period or a numeric restoration objective. [VA09](https://www.procaresoftware.com/trust-security-compliance/security/), [VA10](https://www.procaresoftware.com/trust-security-compliance/)
- **Pricing.** The pricing destination is a request form with no public general-center price. The broader management page contains a separate $25/month home-version offer inside its savings calculator copy. That price is not evidence of pricing or entitlement for a Kumon center. [VA11](https://www.procaresoftware.com/request-pricing/), [VA08](https://www.procaresoftware.com/capabilities/child-care-management-software/)
- **Design lesson for the in-house system.** Link inquiry, family, student, enrollment, schedule, and attendance without copying the same person into separate modules. Support center-specific access and reports from the start. Keep a documented recovery process in addition to a backup job. Staff-only roles should expose only the student and contact information needed for their work.
- **Still unknown.** The pages reviewed do not establish QR workflow details, an exact check-in monitor workflow, offline mode, attendance export formats, two-year retention and termination access, a public API, or whether a particular plan includes every advertised feature.

## brightwheel

- **Evidence.** The official attendance page describes student and staff sign-in/out by scan or code, room moves, absence marking, current and historical attendance corrections, daily/classroom/status reports, real-time room counts, and attendance-linked billing. It states that missed attendance actions can be corrected. These claims support the general workflow cited in the PDF, but the exact named "Attendance Mode" interface was not independently tested. [VA12](https://mybrightwheel.com/child-care-attendance-tracking/)
- **Security.** The security page describes two-factor authentication and staff-level permissions. The security FAQ states that data is encrypted in transit and at rest and that application servers, databases, and backups are in US AWS data centers. It explicitly says brightwheel itself does not currently hold SOC 2 certification; AWS's certifications cover AWS infrastructure. It says single sign-on is not currently available. Do not attribute AWS certification to the vendor's application. [VA13](https://mybrightwheel.com/security/), [VA14](https://help.mybrightwheel.com/en/articles/6363539-brightwheel-security-faqs)
- **Retention and ownership.** The FAQ says records belong to the program and that programs may access, download, or request their data. It says retention is as long as necessary for service and legitimate business, legal, and compliance purposes, with no universal published automatic deletion timeline. This does not verify the required two-year attendance retention commitment. [VA14](https://help.mybrightwheel.com/en/articles/6363539-brightwheel-security-faqs)
- **Pricing.** The public pricing page requests information to customize pricing. It lists attendance, student rosters and profiles, digital signatures, schedules, and reporting, without a numeric subscription price. [VA15](https://mybrightwheel.com/pricing/)
- **Design lesson for the in-house system.** Corrections need a controlled, auditable exception flow. Preserve original values, corrected values, reason, actor, and amendment time. A corrected historical record must never masquerade as a live arrival event. Show the current roster separately from planned visits and historical reports.
- **Still unknown.** No tested attendance workflow, offline capture/synchronization, contractual two-year retention, event export schema, public attendance API, or selected-plan quote. The FAQ's 99.9% uptime statement is a vendor claim, not a reviewed service-level agreement.

## KidCheck

- **Evidence.** The reporting page describes attendance logs and rosters, date-range report exports, custom reporting, current child/worker locations, and visitor follow-up reports. The Roster Check-In page describes checking individual or multiple children in and out from a staff roster without requiring parents to enter a phone number. [VA16](https://www.kidcheck.com/childrens-check-in-attendance-and-reporting), [VA17](https://www.kidcheck.com/feature/roster)
- **Operational oversight.** The Admin Console page describes a live list of checked-in children, mobile access for evacuation or fire drills, room capacity, location corrections, emergency texts, checkout, and authorized or unauthorized guardian information. Mobile access outside the facility is not proof that the roster works without a network. [VA18](https://www.kidcheck.com/feature/admin-console/)
- **Hardware.** Official requirements list supported desktop browsers and tablets and explicitly exclude Chromebooks and Amazon Fire tablets. They recommend a wired network for computer check-in stations. Hardware fit needs testing before procurement, even when a product appears browser-based. [VA19](https://www.kidcheck.com/features-pricing/system-requirements/)
- **Pricing.** Published monthly figures are Starter $25, Plus $45, and Premier $60 for one check-in device. Unlimited-device add-ons are respectively $15, $30, and $60 monthly, producing $40, $75, and $120 totals. The page uses a dollar sign without explicitly stating currency. It says pricing is based on features rather than member count and includes setup, training, support, and updates. It advertises a 5% discount for 12 months paid upfront. These are published figures, not a quote; confirm currency, hardware, consumables, taxes, and feature inclusion. [VA20](https://www.kidcheck.com/features-pricing/pricing/)
- **Design lesson for the in-house system.** Provide a fast staff roster with explicit per-student confirmation. Batch actions should only cover students physically observed to arrive or depart together. Provide an emergency roster with a visible capture time and keep pickup authorization separate from attendance identity.
- **Still unknown.** Two-year retention, record availability after termination, offline capture, offline emergency roster access, correction audit guarantees, backup/restore objectives, export formats, and API/webhook availability. Exporting reports does not by itself prove complete portable data export.

## Implications for the BRD, FRD, and FDR

1. The attendance baseline should ship before wider CRM automation. A missed arrival, false departure, unavailable roster, or lost record is more consequential than a missing marketing dashboard.
2. Common vendor patterns support a narrow first release with unique student identity, staff-mediated arrival/departure, a current roster, history and export, role-based access, an audit trail, and tested continuity. Lead, family, enrollment, scheduling, and communications modules can expand the product without changing the attendance event model.
3. Offline capture, data backup, disaster recovery, record retention, and a usable emergency roster are different capabilities. Specify and test each one. Lillio supplies an explicit offline check-in example, but the research does not establish a universal offline solution across vendors.
4. Preserve the original evidence chain. An attendance event needs event time, receipt time, actor, device, center, source method, and any later correction linkage. An import or delayed sync must remain distinguishable from immediate live capture.
5. No reviewed page establishes all eight supplied Kumon baseline requirements. "Secure," "compliant," "real time," and "cloud backed up" are not acceptance criteria. Use measurable requirements and a demonstration script for annual review.
6. The source PDF's $25-$75/month estimate is illustrative, not a project budget or a verified market range. KidCheck's published unlimited-device Premier price already exceeds that range. An in-house system budget must include development, hosting, devices, backups, support, training, and maintenance.

## Source index

| ID | Official source | What it supports |
| --- | --- | --- |
| VA01 | https://www.lillio.com/features/attendance-tracking | Attendance, offline check-in, pickup intent, print records |
| VA02 | https://www.lillio.com/faq | Daily backup and inactive-student record access claims |
| VA03 | https://www.lillio.com/internet-safety | Encryption and hosting claims |
| VA04 | https://www.lillio.com/features/pricing | No numeric price in retrieved content |
| VA05 | https://mydigitalchildcare.com/solutions/childcare-attendance-software/ | Attendance, reporting, multi-location and absence notifications |
| VA06 | https://mydigitalchildcare.com/ | Product context and expired promotion |
| VA07 | https://mydigitalchildcare.com/pricing/ | Free 0-5-child tier; paid tiers require quote |
| VA08 | https://www.procaresoftware.com/capabilities/child-care-management-software/ | Attendance, broader CRM, reporting, separate home-version offer |
| VA09 | https://www.procaresoftware.com/trust-security-compliance/security/ | Roles, MFA, geographic redundancy claims |
| VA10 | https://www.procaresoftware.com/trust-security-compliance/ | SOC 2 Type 2 claim |
| VA11 | https://www.procaresoftware.com/request-pricing/ | General-center quote required |
| VA12 | https://mybrightwheel.com/child-care-attendance-tracking/ | Attendance, room moves, correction, reporting |
| VA13 | https://mybrightwheel.com/security/ | Account and staff permission controls |
| VA14 | https://help.mybrightwheel.com/en/articles/6363539-brightwheel-security-faqs | Encryption, US storage, retention limits, SOC 2 clarification, SSO absence |
| VA15 | https://mybrightwheel.com/pricing/ | Custom pricing and feature list |
| VA16 | https://www.kidcheck.com/childrens-check-in-attendance-and-reporting | Logs, reports and export |
| VA17 | https://www.kidcheck.com/feature/roster | Staff roster check-in/out |
| VA18 | https://www.kidcheck.com/feature/admin-console/ | Current roster and guardian controls |
| VA19 | https://www.kidcheck.com/features-pricing/system-requirements/ | Device and network constraints |
| VA20 | https://www.kidcheck.com/features-pricing/pricing/ | Published price structure |

Extracted page text and observed links are saved in `research/vendor_raw/`. The extraction script for this group is `research/fetch_vendor_a.py`.
