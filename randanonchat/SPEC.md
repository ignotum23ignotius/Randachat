# RandAnonChat — Full Project Specification

## Tech Stack
- **Frontend:** React PWA (Vite)
- **Backend:** Node.js + Express
- **Database:** PostgreSQL
- **Encryption:** libsodium (X25519-XSalsa20-Poly1305)
- **Hosting:** GCP Compute Engine + Dokku
- **Payments:** Google Play Billing (server-side only)
- **Play Store:** TWA wrapper via PWABuilder

---

## Project Structure
```
randanonchat/
├── SPEC.md
├── .gitignore
├── .env
├── package.json          # root: npm run dev runs both client & server
├── Procfile              # Dokku: web: npm start
├── client/               # React PWA (Vite)
│   ├── package.json
│   ├── vite.config.js    # PWA plugin + proxy /api → :5000
│   ├── index.html
│   └── src/
│       ├── main.jsx
│       ├── App.jsx
│       └── utils/
│           ├── encryption.js
│           └── imageProcessor.js
└── server/               # Express backend
    ├── package.json
    ├── index.js
    ├── middleware/
    │   └── auth.js
    ├── routes/
    │   ├── auth.js
    │   ├── messages.js
    │   ├── images.js
    │   ├── friends.js
    │   ├── groups.js
    │   ├── matching.js
    │   ├── payments.js
    │   └── users.js
    └── db/
        ├── index.js
        └── schema.sql
```

---

## Security & Safety

### CSAM Detection
- Hash check runs CLIENT-SIDE before any processing
- Uses PhotoDNA / NCMEC hash database
- On match:
  - Log metadata only: hash, IP, account ID, timestamp, device fingerprint
  - Report metadata to NCMEC CyberTipline API automatically
  - Discard image immediately — never stored anywhere
  - Shadow ban user immediately
- Image NEVER touches the server

### Shadow Ban System
- Banned users get fake success on login — they never know they are banned
- Banned user's app becomes an isolated shell
- App appears to function normally but nothing reaches the real server
- On every login from a banned device fingerprint, log it silently server-side
- Device fingerprints stored as JSONB array on users table
- ban_type enum: none, shadow, permanent

### E2E Encryption
- X25519-XSalsa20-Poly1305 (libsodium crypto_box)
- Key pair generated on signup
- Public key stored in database
- Private key stored in localStorage ONLY — never leaves device
- Messages encrypted with recipient public key
- Server stores only encrypted blobs — cannot read any content
- Images use hybrid encryption:
  - Random symmetric key encrypts blob via crypto_secretbox
  - Symmetric key sealed to recipient public key via crypto_box_seal
  - For groups: same blob, symmetric key sealed to each member's public key

---

## Database Schema

### users
```sql
id UUID PRIMARY KEY
username TEXT UNIQUE NOT NULL          -- format: NounVerb12345
password_hash TEXT NOT NULL            -- Argon2id
public_key TEXT NOT NULL               -- X25519 public key
age INTEGER CHECK (age >= 18 AND age <= 100)
gender gender_enum NOT NULL            -- m, f, trans, other
location location_enum NOT NULL        -- usa, canada, eu, other
tier user_tier DEFAULT 'free'          -- free, subscribed
sub_expiry TIMESTAMP
diamonds INTEGER DEFAULT 0 CHECK (diamonds >= 0)
daily_random_count INTEGER DEFAULT 0
random_allowance INTEGER DEFAULT 25    -- base 25, increases with purchases
last_random_reset TIMESTAMP DEFAULT NOW()
purchased_features JSONB DEFAULT '{}'  -- permanent unlocks
is_banned BOOLEAN DEFAULT FALSE
ban_type ban_type_enum DEFAULT 'none'
device_fingerprints JSONB DEFAULT '[]'
age_filter_min INTEGER DEFAULT 18
age_filter_max INTEGER DEFAULT 100
gender_filter JSONB DEFAULT '["m","f","trans","other"]'
location_filter JSONB DEFAULT '["usa","canada","eu","other"]'
randoms_enabled BOOLEAN DEFAULT TRUE
created_at TIMESTAMP DEFAULT NOW()
updated_at TIMESTAMP DEFAULT NOW()
```

### user_sessions
```sql
id UUID PRIMARY KEY
user_id UUID REFERENCES users(id)
started_at TIMESTAMP NOT NULL
ended_at TIMESTAMP
duration_s INTEGER GENERATED ALWAYS AS
  (EXTRACT(EPOCH FROM (ended_at - started_at))::INTEGER) STORED
```

### profile_pictures
```sql
id UUID PRIMARY KEY
user_id UUID REFERENCES users(id)
display_order INTEGER CHECK (display_order BETWEEN 1 AND 10)
encrypted_blob_url TEXT NOT NULL
encryption_iv TEXT NOT NULL
uploaded_at TIMESTAMP DEFAULT NOW()
friends_only BOOLEAN DEFAULT TRUE
UNIQUE(user_id, display_order)
```

### friends
```sql
id UUID PRIMARY KEY
user_id_1 UUID REFERENCES users(id)
user_id_2 UUID REFERENCES users(id)
requested_by UUID REFERENCES users(id)
status friend_status DEFAULT 'pending'  -- pending, accepted
created_at TIMESTAMP DEFAULT NOW()
updated_at TIMESTAMP DEFAULT NOW()
UNIQUE(LEAST(user_id_1,user_id_2), GREATEST(user_id_1,user_id_2))
CHECK (user_id_1 != user_id_2)
```

### messages
```sql
id UUID PRIMARY KEY
sender_id UUID REFERENCES users(id)
recipient_id UUID REFERENCES users(id)  -- null if group message
group_id UUID REFERENCES groups(id)     -- null if direct message
encrypted_content TEXT NOT NULL
encryption_iv TEXT NOT NULL
burn_after_read BOOLEAN DEFAULT FALSE
burn_timer_seconds INTEGER              -- 10, 30, 60, 600, 3600
opened_at TIMESTAMP
self_destruct_at TIMESTAMP             -- set when opened
expires_at TIMESTAMP                   -- 24hrs after send if unopened
read BOOLEAN DEFAULT FALSE
created_at TIMESTAMP DEFAULT NOW()
CHECK (
  (recipient_id IS NOT NULL AND group_id IS NULL) OR
  (recipient_id IS NULL AND group_id IS NOT NULL)
)
```

### groups
```sql
id UUID PRIMARY KEY
creator_id UUID REFERENCES users(id)
encrypted_name TEXT NOT NULL
name_iv TEXT NOT NULL
watermark_enabled BOOLEAN DEFAULT TRUE
max_members INTEGER DEFAULT 50
created_at TIMESTAMP DEFAULT NOW()
updated_at TIMESTAMP DEFAULT NOW()
```

### group_members
```sql
id UUID PRIMARY KEY
group_id UUID REFERENCES groups(id)
user_id UUID REFERENCES users(id)
joined_at TIMESTAMP DEFAULT NOW()
removed_at TIMESTAMP
removed_by UUID REFERENCES users(id)
removal_reason removal_reason_enum     -- left, kicked, banned
```

### group_pictures
```sql
id UUID PRIMARY KEY
group_id UUID REFERENCES groups(id)
display_order INTEGER CHECK (display_order BETWEEN 1 AND 10)
encrypted_blob_url TEXT NOT NULL
encryption_iv TEXT NOT NULL
uploaded_at TIMESTAMP DEFAULT NOW()
UNIQUE(group_id, display_order)
```

### purchases
```sql
id UUID PRIMARY KEY
user_id UUID REFERENCES users(id)
order_id TEXT UNIQUE                   -- Google Play order ID
product_id TEXT                        -- Google Play product ID
purchase_token TEXT                    -- Google Play token
diamonds_amount INTEGER CHECK (diamonds_amount > 0)
usd_amount NUMERIC(10,2)
receipt_data JSONB
status purchase_status DEFAULT 'pending'  -- pending, completed, refunded
created_at TIMESTAMP DEFAULT NOW()
```

### app_statistics
```sql
id UUID PRIMARY KEY
stat_date DATE UNIQUE NOT NULL
daily_active_users INTEGER DEFAULT 0
peak_concurrent INTEGER DEFAULT 0
total_matches INTEGER DEFAULT 0
avg_session_duration_s INTEGER DEFAULT 0
```

### csam_reports
```sql
id UUID PRIMARY KEY
reporting_user_id UUID REFERENCES users(id)
image_hash TEXT NOT NULL               -- hash only, NO image ever
ip_address TEXT
device_fingerprint TEXT
context JSONB
reported_at TIMESTAMP DEFAULT NOW()
reviewed BOOLEAN DEFAULT FALSE
reviewed_by UUID REFERENCES users(id)
reviewed_at TIMESTAMP
```

### blocked_users
```sql
id UUID PRIMARY KEY
blocker_id UUID REFERENCES users(id)
blocked_id UUID REFERENCES users(id)
type block_type_enum                   -- block, ignore
created_at TIMESTAMP DEFAULT NOW()
UNIQUE(blocker_id, blocked_id)
```

---

## Accounts & Authentication

### Username System
- Format: [Noun][Verb][12345] — e.g. TigerRuns48291
- Server-generated at signup using CSPRNG
- 50 nouns × 50 verbs × 90,000 numbers = ~225M combinations
- Permanent — user cannot regenerate
- Retry up to 10x on collision

### Password Policy
- 30 character minimum
- Must include: 5+ letters, 5+ numbers, 5+ symbols
- Hashed with Argon2id (64MB memory, 3 iterations, OWASP recommended)
- Signup screen recommends KeePassXC and Bitwarden with links

### Signup Fields
- Username: auto-generated, shown to user
- Password: 30 char min with complexity requirements
- Age: slider 18-100
- Gender: M / F / Trans / Other
- Location: USA / Canada / EU / Other
- Age gate checkbox: "I confirm I am 18 or older" — required

### JWT
- 7 day expiry
- Payload contains only id and username
- Secret from environment variable

---

## User Identification & Profile

### What Other Users See (friends only):
- Username
- Display name
- Age range (not exact)
- Gender
- Location
- Profile pictures (friends only — hidden from randoms)

### Profile Pictures
- Up to 10 photos
- Same pipeline as image sending (CSAM → Crop → Filter → Text → EXIF → Encrypt)
- Visible ONLY to mutual friends — randoms see placeholder avatar
- 3 hour cooldown per slot on delete/replace
- First photo = primary display photo
- Swipeable gallery

---

## Image Processing Pipeline

### Full Pipeline Order:
```
User selects image (camera or gallery — no UI difference)
        ↓
CSAM hash check (client-side)
        ↓
Strip ALL EXIF data (GPS, device info, timestamp — everything)
        ↓
Crop
        ↓
Filter
        ↓
Text overlay
        ↓
Encrypt with recipient's public key (libsodium)
        ↓
Upload encrypted blob to server
```

### Crop System
- Aspect ratio bar at bottom, scrolls LEFT TO RIGHT
- Phone ratios: 9:16, 4:5, 1:1
- Artsy ratios: 3:2, 16:9, 4:3, free
- Corner drag: maintains selected ratio, scales crop window up/down
- Center drag: moves crop box within image, NEVER escapes image bounds
- Tap Apply to confirm crop

### Filters
- Sépia
- Skin smoothing
- Eye enhancement / pop
- B&W
- Contrast
- Warmth

### Text Overlay
- 3 curated attractive fonts
- Size slider
- Glow toggle (on/off)
- Glow color wheel

### Image Rules
- All processing CLIENT-SIDE using Canvas API
- Raw image never touches server
- Max input size: 40MB
- EXIF stripped before any other processing

### Image Expiry
- Self-destruct: 30 seconds after recipient first opens
- Unopened expiry: auto-deleted after 24 hours
- Both client-side and server-side deletion on expiry

---

## Chat System

### Message UI
- Bubble style messages
- Read receipts
- Typing indicators
- No message deletion

### Burn On Read
- Per conversation setting — recipient controls their own timer
- Options: 10s, 30s, 1m, 10m, 1hr
- Timer starts on first open by recipient
- Sender sees 🔥 + timer value on every message they send
  e.g. 🔥 30s visible next to each sent message
- After timer expires message deleted client-side and server-side

---

## Inbox & Chat Selection

### Inbox Layout
- Top: Randoms toggle (ON/OFF) — always visible
- Top: Two tabs — Friends | Randoms
- Bottom bar: Chat icon (new random) + Settings icon
- Switching tabs never affects Randoms toggle

### Randoms Toggle
- ON: you appear in random matching pool
- OFF: invisible to randoms, friends can still message you
- State persists between sessions

### Filter Settings (bottom settings icon)
- Age range: dual slider (min/max)
- Gender: checkboxes — select one or many
- Location: checkboxes — select one or many
- Apply button

### Mutual Filter Matching
- Both sides must match each other's filters
- You only see people who match YOUR filters
- You only appear to people whose filters YOU match
- Both conditions must be true simultaneously

---

## Dynamic Matching Algorithm (Fully Automated)

### Base Window Calculation
```sql
-- Average return interval between sessions
SELECT AVG(hours_between_sessions)
FROM user_sessions
WHERE session_start >= NOW() - INTERVAL '30 days'
```
This becomes the base_window — no hardcoded values.

### Activity Ratio
```sql
-- Today's DAU vs 30-day average
SELECT AVG(daily_active_users)
FROM app_statistics
WHERE stat_date >= NOW() - INTERVAL '30 days'
```
activity_ratio = today's DAU ÷ 30-day average DAU

### Final Window
```
final_window = base_window ÷ activity_ratio
```
- High activity → tighter window (fresher matches)
- Low activity → wider window (keeps app usable)
- Fully self-calibrating, zero hardcoded numbers

### Weighted Ranking Within Window
```
recency_score = time_since_last_online ÷ final_window
```
Proportional — no magic numbers.

### Match Priority Queue
```
Filter pool (mutual match)
        ↓
Remove friends
        ↓
Remove fresh unread randoms
        ↓
Sort by recency score (most recent first)
        ↓
Serve top of list
        ↓
If pool empty → serve least-recently-seen random
(preserve existing chat history)
```

### Repeat Rules
- Randoms: can be served again, chat history preserved
- Friends: NEVER served as a random again

---

## Friends System

### Adding a Friend
- Add button sits beside username in chat window
- Tap → small banner appears at top of THEIR chat window
- Banner text: "[username] has added you as a friend, do you want to add them back?"
- Options: Accept / Dismiss
- Request NEVER expires — sits until acted on

### On Mutual Accept
- Moves from Randoms tab → Friends tab
- Removed from random matching pool forever
- Chat history preserved
- Profile pictures become visible to each other

### One-Way Add
- They dismiss → stays in Randoms tab
- No pending state cluttering Friends tab

---

## User Search System

### UI
- Two input boxes side by side in the inbox screen
- Left box placeholder: `Name`
- Right box placeholder: `#####`
- No other instructions or hints beyond the placeholders

### Search Logic
- **Right box only (numbers):** Search by ID number portion of username — returns all users with that exact number (max 1-5 results)
- **Left box only (text):** Search by noun+verb portion of username — exact match only
- **Both boxes filled:** Search full username NounVerb12345 — exact match only
- Results show username only — no profile info, no pictures
- Tap result → opens chat

### Privacy
- Cannot browse users
- Must know at least half the username exactly
- Maximum 2-3 results ever returned
- No profile info exposed to strangers
- The number-based search is intentionally undocumented — observant users discover it themselves

### Backend
- GET /api/users/search?q= endpoint in server/routes/users.js
- Mounted at /api/users in server/index.js
- Uses shared pool from ../db

---

## Block / Ignore System
- Ignore: messages go to hidden folder, they don't know
- Block: cannot message at all, ever
- Both managed in main app settings
- Blocked/ignored users never notified of status
- Removal: user manually removes from list in settings

---

## Groups System

### Creation
- Any user can create a group
- Creator sets the group name
- Name is E2E encrypted — members don't see it until they join
- Add members by username

### Group Profile Pictures
- Same pipeline as image sending
- Up to 10 photos
- Creator managed only
- 3 hour cooldown per slot

### Permissions
- Creator only can: add/remove members, manage group photos
- Removing a member wipes ALL group traces from their device
- Does not affect anything they already downloaded

### Leak Prevention Watermark
- Group chat background: horizontal opaque watermark
- Watermark text: [group name] + [viewing user's username]
- Every image sent in group: watermark auto-overlaid before display
- Every screenshot is traceable to the specific user who leaked it

---

## Tier System & Paywalls

### Free Tier Limits
- 25 randoms per day (resets every 24hrs)
- Location filter only
- 1 profile picture
- 1 group, max 5 members

### Subscribed Tier ($10/month)
- Unlimited randoms per day
- All filters (age + gender + location)
- All 10 profile picture slots
- Unlimited groups, unlimited members

### "Keep What You Earned" Rule
When subscription lapses:
- Groups stay — can't add new members over 5 without paying
- Profile pics stay — can't add new ones over free limit
- Group members stay — can't add more without paying
- Randoms reverts to 25/day
- Filters revert to location only

### Permanent Micropayment Unlocks
- Filter unlock (age + gender together): 100 💎 ($1.00)
- Extra profile pic per slot: 30 💎 ($0.30)
- Extra group: 200 💎 ($2.00)
- Extra group member per member: 50 💎 ($0.50)

### Random Bundles
| Bundle | Diamonds | Price |
|--------|----------|-------|
| +50 randoms | 100 💎 | $1.00 |
| +100 randoms | 200 💎 | $2.00 |
| +250 randoms | 300 💎 | $3.00 |
| +50 randoms + filters | 200 💎 | $2.00 |
| +100 randoms + filters | 400 💎 | $4.00 |
| +250 randoms + filters | 600 💎 | $6.00 |
| Monthly sub | 1000 💎 | $10.00 |

---

## Diamond System

### Conversion Rate
1000 💎 = $10.00 (clean, transparent, no tricks)

### Purchase Bundles (with bonus diamonds for larger purchases)
| USD | Diamonds | Bonus |
|-----|----------|-------|
| $1.00 | 100 💎 | — |
| $5.00 | 500 💎 | — |
| $10.00 | 1000 💎 | — |
| $20.00 | 2100 💎 | +100 free |
| $50.00 | 5400 💎 | +400 free |
| $100.00 | 11000 💎 | +1000 free |
| $200.00 | 24000 💎 | +4000 free |

### Payment Processing
- Google Play Billing ONLY
- Google takes 30% cut
- All billing logic lives SERVER-SIDE only (not in client code)
- Client sends purchase request to server
- Server handles all Google Play Billing API calls
- This keeps billing code out of open source client

---

## PWA & Play Store

### PWA Requirements
- Web app manifest
- Service worker for offline support
- Install prompt for Android Chrome
- Full screen, no browser bar

### Play Store Distribution
- TWA (Trusted Web Activity) wrapper via PWABuilder
- $25 one-time Google Play developer fee
- App served from randanonchat.com

---

## Infrastructure

### Server
- GCP Compute Engine (europe-west1-b)
- Ubuntu 22.04 LTS
- e2-medium (2 vCPU, 4GB RAM)
- Static IP: 34.140.26.34
- Dokku for deployments

### Database
- GCP Cloud SQL PostgreSQL 15
- Connected via DATABASE_URL environment variable

### Storage
- GCP Cloud Storage for encrypted image blobs

### SSL
- Let's Encrypt via dokku-letsencrypt plugin
- Auto-renews via cron job

### Domain
- randanonchat.com (Cloudflare)
- DNS A record → 34.140.26.34

### Deployment
- Git push to Dokku from local machine
- Dokku auto-builds and restarts

---

## Environment Variables
```
PORT=5000
DATABASE_URL=postgres://...
NODE_ENV=production
JWT_SECRET=<random 64 byte hex>
NCMEC_API_KEY=<from NCMEC>
GOOGLE_PLAY_PUBLIC_KEY=<from Play Console>
```

---

## Open Source Strategy
- Full codebase open source
- Payment logic lives SERVER-SIDE only — never in client
- Client only sends "purchase request" to server
- Server handles all billing privately
- Suggested license: AGPL-3.0

---

## Design System

### Colors
- Background base: #1c0626
- Background mid: #38074f
- Background light: #491063
- Accent gold dark: #666106
- Accent gold mid: #807a1b
- Accent gold warm: #80591b
- Accent gold orange: #802f1b

### Fonts (Google Fonts)
- Display / Headings / Body: Uncial Antiqua
- UI elements / labels / buttons: IM Fell English

### Animation
- Ink reveal — text masked, mask sweeps left to right revealing text
- Triggers per section as it scrolls into view
- Each section animates independently
- Slow and deliberate — cryptic feel

### Vibe
- Dark, moody, secret society
- Like stumbling onto something you weren't supposed to find
- Sparse — nothing wasted
- Gold on deep purple throughout

---

## Landing Page (randanonchat.com — root)

### File Location
- server/public/index.html
- Served at / by Express
- Standalone HTML file — no React, no build step

### Hero Image
- File: /public/hero.png (the full artwork — daggers, eye, candle, Randachat text)
- Centered, full width on mobile, max-width 600px on desktop

### Section 1 — Hero
```
[Hero image]

They aren't watching here.

A private, encrypted, open-source social network for adults.
No ads. No trackers. No governments. No AI trying to sell you soap.

[Enter] ← gold button, links to /app
```

### Section 2 — Features
```
🜏 End-to-end encrypted
Every message. Every image. Every word.
Unreadable to anyone but you and who you chose.

☽ Open source
Every line of code is public.
Trust nothing you can't verify.

⚸ No surveillance
No ad profiles. No behavioral tracking. No data brokers.
You are not the product.

🝒 Adult focused
Built for grown ups. Treated like one.
```

### Section 3 — How It Works
```
Match. Message. Disappear.

Find a random stranger. Talk. Send images that vanish.
Make a friend if you want one. Invite them somewhere private.
Leave no trace if you don't.
```

### Section 4 — Pricing
```
Free, forever:
25 matches a day. 1 group. Endless messages.
No expiry. No credit card.

A little more, for a little more:
More matches. More groups. More control.
Honest prices. No dark patterns.

[$10/month or pay as you go →] ← gold button, links to /app
```

### Section 5 — Footer
```
Privacy Policy · Terms of Service · GitHub ↗ · © 2025 Randachat
```
- Privacy Policy links to /privacy
- Terms of Service links to /tos
- GitHub links to the public repo (placeholder href for now)

### Styling Rules
- Full viewport height hero section
- Each section separated by generous padding
- Text centered
- Gold (#807a1b) for headings and accent elements
- Light gold (#807a1b at 70% opacity) for body text
- Deep purple gradient background top to bottom (#1c0626 → #38074f)
- Enter button: gold border, gold text, dark background, no fill — on hover subtle gold glow
- No images other than hero
- Mobile first

---

## Landing Page Bugs To Fix
- Scroll reveal too fast — needs to be much slower
- Text appearing instantly instead of revealing — animation not working
- Enter button right border missing — CSS bug
- Button style — gold background, purple text (currently reversed)

---

## App UI (/app — React PWA)

### Global App Design Rules
- Same color system as landing page
- Same fonts — Uncial Antiqua + IM Fell English
- Dark backgrounds throughout — never white or light
- Gold accents for interactive elements
- Bubble messages: sender (you) gold, recipient orange (#802f1b)
- All screens mobile-first
- No ink reveal animation inside the app — landing page only
- Subtle fade-in on screen load only
- Currency symbol: 🜃 (alchemical gold) — internal name diamonds, display as 🜃
- Placeholder avatar: purple eye image (client/public/eye.png)
- Unread indicator: random occult emoji (🜏 ☽ ⚸ 🝒 ☿ ⚔ 🜄), gold, large font, far right of conversation item

---

### Signup Screen — 4 Step Flow

**Progress bar (every step):**
- "X of 4" above bar — IM Fell English, orange accent #802f1b
- Gold fill bar, orange outline #802f1b
- Smooth fill animation between steps

**Step 1 — Password Manager:**
- Warning: you need a password manager to use this app
- Links to KeePassXC and Bitwarden
- Checkbox: "I have a password manager ready"
- Next button

**Step 2 — Account:**
- Auto-generated username displayed prominently
- One password field with complexity requirements shown

**Step 3 — About You:**
- Age slider 18-100
- Gender selection (M / F / Trans / Other)
- Location selection (USA / Canada / EU / Other)

**Step 4 — Legal:**
- Age gate checkbox: "I confirm I am 18 or older"
- TOS agreement checkbox
- Submit button

---

### Login Screen
- Username field
- Password field
- Remember username checkbox (client side only)
- No remember password option
- Login button — gold background, purple text

---

### Inbox Screen

**Header rows (top to bottom):**
1. Randoms toggle
2. Search — two boxes side by side: Name | #####
3. Tabs — Friends | Randoms | Groups

**Randoms Toggle:**
- OFF: "Enter the Randa" — no emojis, dimmed, muted gold
- ON: "Randa's Approaching" — occult emojis pulsing both sides, bright gold
- Pulsing emojis: grow and shrink slowly, same as typing indicator

**Conversation list item:**
- Left: profile pic or purple eye placeholder (circular)
- Center: username
- Far right: timestamp, then unread occult emoji in large gold font if unread
- No message preview

**Groups tab conversation list:**
- Group profile pic or purple eye placeholder
- Most recent sender's username (group name is encrypted)
- Same unread indicator

**Bottom bar — Friends tab:**
- Left: 🕯️ — start new random chat
- Right: 🔮 — filter settings sheet

**Bottom bar — Randoms tab:**
- Left: 🕯️ — start new random chat
- Right: 🔮 — filter settings sheet

**Bottom bar — Groups tab:**
- Left: 🕯️ — start new random chat
- Right: ✦ — create new group

---

### Chat Screen

**Header (left to right):**
- Far left: profile pic / purple eye placeholder
- Center: username
- Right of username: ⚙️ settings cog
- Far right: back arrow

**Settings cog — bottom sheet:**
- Add Friend
- Ignore
- Block

**Message bubbles:**
- Your messages: right side, gold
- Their messages: left side, orange (#802f1b)

**Input bar (left to right):**
- 🕯️ burn timer button — opens bottom sheet (OFF/10s/30s/1m/10m/1hr)
- Text input
- Image attachment button
- Send button

**Burn indicator:**
- 🕯️ + timer value beside every message when burn is active

**Typing indicator:**
- Three occult symbols slowly growing and shrinking — hypnotic, deliberate

**Read receipt:**
- 📜 scroll emoji under sent message when read

**Friend request banner:**
- Gold banner at top of chat
- "[username] has added you as a friend"
- Permanent — stays until YOU add them back via settings cog
- No buttons on banner

---

### Burn Timer — Text vs Image

**Text messages:**
- 🕯️ in input bar → bottom sheet slides up
- Options: OFF, 10s, 30s, 1m, 10m, 1hr
- Gold selected state, purple background
- Does not disrupt text input

**Images:**
- Burn step in image editor (step 5)
- Simple checkbox ON/OFF
- If ON — timer picker appears: 10s, 30s, 1m, 10m, 1hr

---

### Image Editor — 5 Steps

**Every step:**
- Top bar: Cancel (left) | Next (right) — gold text, purple bar
- Bottom bar: controls — purple bar
- Image fills space between bars

**Step 1 — Crop:**
- Bottom bar: aspect ratio names scroll left to right
- Selected ratio: gold background, purple text
- Unselected: purple background, gold text
- Crop box outline: gold
- Corner dots: purple, inviting drag
- Center drag: moves crop box, never escapes bounds
- No dimmed area outside crop

**Step 2 — Filter:**
- Bottom bar: filter names scroll left to right
- Selected filter: gold background, purple text
- No previews — name only

**Step 3 — Text:**
- Bottom bar: 3 font names
- Tap font → cursor appears in image, keyboard opens
- Type, then drag text anywhere on image
- Vertical size slider on LEFT side of screen

**Step 4 — Glow:**
- Bottom: simple color wheel
- No glow selected by default
- Tap wheel to pick color — glow activates on text
- Hit Next without tapping — no glow applied

**Step 5 — Burn:**
- 🕯️ checkbox ON/OFF
- If ON — timer picker: 10s, 30s, 1m, 10m, 1hr
- Next becomes Send

**CSAM check:**
- Runs before editor opens
- User sees blank loading screen — looks like normal loading

---

### Profile Screen
- Large primary photo top, full width
- Tap → swipeable gallery of uploaded photos
- Purple eye placeholder if no photos
- Below photo: username, age, gender, location (one line)
- Bio — max 100 words, visible to ALL users including randoms
- No edit controls on this screen — everything in settings
- Empty photo slots do not appear in gallery

---

### Settings Screen

**Profile section:**
- Bio field — Uncial Antiqua, 100 word live counter, warning: "Your bio is visible to all users including randoms"
- Photo grid — uploaded photos show, empty slots hidden, tap to upload/replace, cooldown slots show countdown timer overlay in orange accent

**Privacy section:**
- Block/ignore list — scrollable, username + purple eye per entry, tap to unblock/unignore, confirmation before removing

**Account section:**
- Username display — gold, not editable
- Logout button — gold background, purple text
- Delete account — orange accent #802f1b, confirmation dialog, deletes everything possible, closes owned groups

**Payments section:**
- Current tier — Free or Subscribed
- 🜃 balance — large gold number
- Buy 🜃 button
- Manage subscription button (if subscribed)
- Subscription key redemption field — enter key, redeem for 1 month sub

---

### Filter Settings Sheet (🔮 crystal ball)
- Slides up from bottom, half screen
- No title — straight into controls
- Age dual slider — always free, no chains
- Gender checkboxes — ⛓️ chains if locked, orange "Unlock this match with filters — 4 🜃" button
- Location checkboxes — always free, no chains
- Apply button bottom — gold background, purple text

---

### Create New Group Flow (✦ button)
- Simple name input screen
- Type group name
- Confirm — auto sends "hello world" first message
- Group appears in Groups tab with most recent sender username shown

---

### Group Settings (⚙️ cog in group chat)

**For creator:**
- Group photo management
- Add member by username
- Remove member
- Toggle watermark ON/OFF

**For members:**
- Leave group — orange accent, confirmation dialog

---

### Payments Screen — "The Ritual"

**Header:**
- 🜃 balance — large, gold, centered
- Current tier below

**"Offer to the Randa" — 🜃 bundles:**
| USD | 🜃 | Bonus |
|-----|-----|-------|
| $1.00 | 100 🜃 | — |
| $5.00 | 500 🜃 | — |
| $10.00 | 1000 🜃 | — |
| $20.00 | 2100 🜃 | +100 free |
| $50.00 | 5400 🜃 | +400 free |
| $100.00 | 11000 🜃 | +1000 free |
| $200.00 | 24000 🜃 | +4000 free |

**"Pledge to the Randa" — subscription:**
- $10/month = 1000 🜃/month
- Lists what subscription includes

**"Feed the Randa" — random bundles:**
| Bundle | 🜃 |
|--------|-----|
| +50 randoms | 100 🜃 |
| +100 randoms | 190 🜃 |
| +250 randoms | 450 🜃 |
| +50 randoms + filters | 200 🜃 |
| +100 randoms + filters | 380 🜃 |
| +250 randoms + filters | 900 🜃 |

**Payment flow:**
1. User taps purchase
2. Google Play Billing sheet slides up
3. User completes payment
4. Server confirms, credits 🜃
5. Red splatter animation fires — full screen, bursts from tap point, fades over 1-2 seconds
6. 🜃 balance updates

---

### Piecemeal Purchases — Contextual

**Filter settings (gender/age locked):**
- "Unlock this match with filters — 4 🜃"

**Create group at limit:**
- "Summon a new group — 200 🜃"

**Photo slot at limit:**
- "Claim this slot — 30 🜃"

**Add group member at limit:**
- "Invite this soul — 50 🜃"

**Out of daily matches (🕯️ tapped):**
- "Spend 2 🜃 for one more match"
- "Spend 4 🜃 for one more match with filters"
- Gold warning banner: "Others can still find you even when you're out of matches"

All piecemeal purchases fire red splatter after Google Play confirmation.

---

### Single Item Pricing
| Item | 🜃 |
|------|-----|
| 1 random without filter | 2 🜃 |
| 1 random with filter | 4 🜃 |
| Extra profile pic slot | 30 🜃 |
| Extra group | 200 🜃 |
| Extra group member | 50 🜃 |

---

### Push Notifications
- Silent only — no content, no sender, no preview
- Displays 🜃 symbol only or blank
- User opens app, WebSocket connects, messages deliver instantly
- Must be implemented server-side — on dev agenda

---

### Subscription Key System
- Admin generates keys server-side
- Single use, non-transferable
- Redeemed in settings under payments section
- Grants 1 month subscription on redemption
- On dev agenda

---

## Legal

### TOS
- Filed at server/public/tos.html
- Governing law: State of Louisiana, United States
- Contact: legal@randanonchat.com
- Completed 04/10/2026

### Privacy Policy
- Filed at server/public/privacy.html
- Contact: legal@randanonchat.com
- Completed 04/10/2026

---

## Dev Agenda (in order)

1. Wire landing page in server/index.js — serve server/public at root
2. Fix landing page bugs — scroll speed, button border, button colors
3. Update vite.config.js for /app subpath
4. Update server/index.js to serve React at /app
5. Build server/public/tos.html
6. Build server/public/privacy.html
7. Push notification infrastructure
8. Subscription key system
9. Bio column on users table
10. Build all React app screens (design complete)
11. Deploy to GCP via Dokku
12. Test everything
13. Set up legal@randanonchat.com email
14. Get Louisiana LLC
15. TWA wrapper via PWABuilder
16. Google Play developer account
17. Enable real billing
18. Public launch
