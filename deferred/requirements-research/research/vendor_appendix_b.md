## Vendor research appendix, part B

All sources accessed 14 September 2026. These findings verify what vendors publish; they do not establish tested functionality or compliance with Kumon's requirements.

### V06 Playground

Playground documents QR/PIN kiosk entry, staff and family check-in/out, timestamp and signer attribution, current attendance status, child history, and printed/exported reports. Administrators can add, edit, and delete records. Its API page advertises lead capture, synchronization, dashboards, and billing exports, but specific attendance endpoints and access terms were not verified. These features support a shared student record across enrollment and attendance, with a locked kiosk and a staff presence view. The proposed CRM should preserve original events and correction history rather than permit untracked deletion. Two-year attendance retention, center-side offline recording, offline roster access, and current pricing remain unverified. [V06a, V06b, V06c]

- V06a. Attendance overview: https://help.tryplayground.com/en/articles/16111397-attendance-overview
- V06b. Attendance product: https://www.tryplayground.com/solutions/attendance
- V06c. API: https://www.tryplayground.com/solutions/api

### V07 Famly

Famly publishes PIN and QR entry, expected versus actual attendance, signed-in views, registration forms, lead/waitlist management, and occupancy reporting. Its tablet QR changes every five seconds; a static printed option also exists. Its emergency guide explicitly requires an internet connection to access evacuation information and recommends mobile data or a hotspot. This does not establish offline roster access. Public GraphQL documentation includes check-ins, students, contacts, inquiries, and permission-controlled tokens with expiry. The proposed CRM should separate scheduled attendance from observed presence and test roster access during connectivity loss. Two-year contractual retention and center-side offline event capture were not verified. [V07a, V07b, V07c, V07d]

- V07a. Enrollment and attendance: https://www.famly.co/us/platform/enrollment-attendance
- V07b. QR check-in/out: https://help.famly.co/en-us/articles/8075420-qr-code-check-in-out-screen
- V07c. Emergency workflow: https://help.famly.co/en-us/articles/4912356-in-case-of-emergency
- V07d. Public API reference: https://docs.famly.co/

### V08 Daily Connect

Daily Connect documents parent QR or unique PIN sign-in, optional signatures and surveys, current classroom membership, ratio alerts, saved attendance reports, and report exports. Its broader platform includes enrollment forms, waitlists, deposits, billing, and parent communication. The pricing page displayed Professional at $16/month billed annually, including ten children, then $1.60 per additional child; payment-processing fees and center-specific scope require separate confirmation. The proposed CRM can use the same low-friction entry and immediate staff visibility, with optional sign-out notifications that do not delay attendance recording. Two-year retention, center-side offline attendance or roster access, and a supported public attendance API were not verified. [V08a, V08b, V08c]

- V08a. Attendance: https://en.dailyconnect.com/sign-in-attendance-tracking
- V08b. Homepage: https://en.dailyconnect.com/
- V08c. Pricing: https://en.dailyconnect.com/pricing

### V09 Jumbula

Jumbula's Business App distinguishes session attendance, dismissal, and check-in/out. It documents present/late/absent/excused statuses, timestamps, authorized pickup options, guardian/bus/self-dismissal methods, scan-code/PIN entry, kiosk mode, exception notes, reports, and role-based access. Its homepage advertises registration, payments, campaigns, and custom API integration. Vendor-linked API documentation lists families, participants, parents, and authorized pickups, but attendance endpoints and commercial access remain unverified. The design lesson is to model center presence, subject-session participation, and release authorization separately. Moving from math to reading must not create a false departure. Two-year retention, offline event capture/roster access, and immutable correction history were not verified. [V09a, V09b, V09c]

- V09a. Business App: https://jumbula.com/jb-business-app/
- V09b. Homepage: https://jumbula.com/
- V09c. Vendor-linked API documentation: https://app.theneo.io/hassan-jumbula-com/jumbula2/getting-started/introduction

### V10 EZChildTrack

EZChildTrack documents QR, predefined-code, barcode, and card-based attendance, real-time tablet entry, authorized multiple-child pickup, activity attendance, reports, and centralized family/enrollment records. Parents can save a personalized QR page and present it without internet. This verifies offline credential presentation only; it does not establish disconnected center-side event recording or roster access. Its cloud page describes backups and recovery without measurable recovery targets. The proposed CRM should support inexpensive tablets/scanners, create a separate event for each sibling, and test backup restoration and connectivity loss. Two-year contractual retention, center-side offline operation, a supported public API, and numerical pricing remain unverified. [V10a, V10b, V10c, V10d]

- V10a. Attendance: https://www.ezchildtrack.com/attendance-tracking.html
- V10b. Tablet interface: https://www.ezchildtrack.com/ipad-interface.html
- V10c. Features: https://www.ezchildtrack.com/features.html
- V10d. Cloud storage and backups: https://www.ezchildtrack.com/cloudbased.html
