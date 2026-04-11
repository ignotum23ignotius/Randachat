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
