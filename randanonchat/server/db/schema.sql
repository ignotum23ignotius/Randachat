BEGIN;

-- ============================================================
-- Extensions
-- ============================================================
CREATE EXTENSION IF NOT EXISTS "pgcrypto";   -- gen_random_uuid()

-- ============================================================
-- Enum Types
-- ============================================================
CREATE TYPE gender_enum          AS ENUM ('m', 'f', 'trans', 'other');
CREATE TYPE location_enum        AS ENUM ('usa', 'canada', 'eu', 'other');
CREATE TYPE user_tier            AS ENUM ('free', 'subscribed');
CREATE TYPE ban_type_enum        AS ENUM ('none', 'shadow', 'permanent');
CREATE TYPE friend_status        AS ENUM ('pending', 'accepted');
CREATE TYPE removal_reason_enum  AS ENUM ('left', 'kicked', 'banned');
CREATE TYPE purchase_status      AS ENUM ('pending', 'completed', 'refunded');
CREATE TYPE block_type_enum      AS ENUM ('block', 'ignore');

-- ============================================================
-- 1. users
-- ============================================================
CREATE TABLE users (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username            TEXT UNIQUE NOT NULL,
    password_hash       TEXT NOT NULL,
    public_key          TEXT NOT NULL,
    age                 INTEGER CHECK (age >= 18 AND age <= 100),
    gender              gender_enum NOT NULL,
    location            location_enum NOT NULL,
    tier                user_tier DEFAULT 'free',
    sub_expiry          TIMESTAMP,
    diamonds            INTEGER DEFAULT 0 CHECK (diamonds >= 0),
    daily_random_count  INTEGER DEFAULT 0,
    random_allowance    INTEGER DEFAULT 25,
    last_random_reset   TIMESTAMP DEFAULT NOW(),
    purchased_features  JSONB DEFAULT '{}',
    is_banned           BOOLEAN DEFAULT FALSE,
    ban_type            ban_type_enum DEFAULT 'none',
    device_fingerprints JSONB DEFAULT '[]',
    age_filter_min      INTEGER DEFAULT 18,
    age_filter_max      INTEGER DEFAULT 100,
    gender_filter       JSONB DEFAULT '["m","f","trans","other"]',
    location_filter     JSONB DEFAULT '["usa","canada","eu","other"]',
    randoms_enabled     BOOLEAN DEFAULT TRUE,
    push_token          TEXT,
    created_at          TIMESTAMP DEFAULT NOW(),
    updated_at          TIMESTAMP DEFAULT NOW()
);

-- ============================================================
-- 2. user_sessions
-- ============================================================
CREATE TABLE user_sessions (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID REFERENCES users(id),
    started_at  TIMESTAMP NOT NULL,
    ended_at    TIMESTAMP,
    duration_s  INTEGER GENERATED ALWAYS AS
                (EXTRACT(EPOCH FROM (ended_at - started_at))::INTEGER) STORED
);

-- ============================================================
-- 3. profile_pictures
-- ============================================================
CREATE TABLE profile_pictures (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id            UUID REFERENCES users(id),
    display_order      INTEGER CHECK (display_order BETWEEN 1 AND 10),
    encrypted_blob_url TEXT NOT NULL,
    encryption_iv      TEXT NOT NULL,
    uploaded_at        TIMESTAMP DEFAULT NOW(),
    friends_only       BOOLEAN DEFAULT TRUE,
    UNIQUE(user_id, display_order)
);

-- ============================================================
-- 4. friends
-- ============================================================
CREATE TABLE friends (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id_1    UUID REFERENCES users(id),
    user_id_2    UUID REFERENCES users(id),
    requested_by UUID REFERENCES users(id),
    status       friend_status DEFAULT 'pending',
    created_at   TIMESTAMP DEFAULT NOW(),
    updated_at   TIMESTAMP DEFAULT NOW(),
    UNIQUE(LEAST(user_id_1, user_id_2), GREATEST(user_id_1, user_id_2)),
    CHECK (user_id_1 != user_id_2)
);

-- ============================================================
-- 5. groups
-- ============================================================
CREATE TABLE groups (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    creator_id        UUID REFERENCES users(id),
    encrypted_name    TEXT NOT NULL,
    name_iv           TEXT NOT NULL,
    watermark_enabled BOOLEAN DEFAULT TRUE,
    max_members       INTEGER DEFAULT 50,
    created_at        TIMESTAMP DEFAULT NOW(),
    updated_at        TIMESTAMP DEFAULT NOW()
);

-- ============================================================
-- 6. messages  (after groups so FK resolves)
-- ============================================================
CREATE TABLE messages (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sender_id           UUID REFERENCES users(id),
    recipient_id        UUID REFERENCES users(id),
    group_id            UUID REFERENCES groups(id),
    encrypted_content   TEXT NOT NULL,
    encryption_iv       TEXT NOT NULL,
    burn_after_read     BOOLEAN DEFAULT FALSE,
    burn_timer_seconds  INTEGER CHECK (burn_timer_seconds IN (10, 30, 60, 600, 3600)),
    opened_at           TIMESTAMP,
    self_destruct_at    TIMESTAMP,
    expires_at          TIMESTAMP,
    read                BOOLEAN DEFAULT FALSE,
    created_at          TIMESTAMP DEFAULT NOW(),
    CHECK (
        (recipient_id IS NOT NULL AND group_id IS NULL) OR
        (recipient_id IS NULL AND group_id IS NOT NULL)
    )
);

-- ============================================================
-- 7. group_members
-- ============================================================
CREATE TABLE group_members (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id        UUID REFERENCES groups(id),
    user_id         UUID REFERENCES users(id),
    joined_at       TIMESTAMP DEFAULT NOW(),
    removed_at      TIMESTAMP,
    removed_by      UUID REFERENCES users(id),
    removal_reason  removal_reason_enum,
    UNIQUE(group_id, user_id)
);

-- ============================================================
-- 8. group_pictures
-- ============================================================
CREATE TABLE group_pictures (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id           UUID REFERENCES groups(id),
    display_order      INTEGER CHECK (display_order BETWEEN 1 AND 10),
    encrypted_blob_url TEXT NOT NULL,
    encryption_iv      TEXT NOT NULL,
    uploaded_at        TIMESTAMP DEFAULT NOW(),
    UNIQUE(group_id, display_order)
);

-- ============================================================
-- 9. purchases
-- ============================================================
CREATE TABLE purchases (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID REFERENCES users(id),
    order_id        TEXT UNIQUE,
    product_id      TEXT,
    purchase_token  TEXT,
    diamonds_amount INTEGER CHECK (diamonds_amount > 0),
    usd_amount      NUMERIC(10,2),
    receipt_data    JSONB,
    status          purchase_status DEFAULT 'pending',
    created_at      TIMESTAMP DEFAULT NOW()
);

-- ============================================================
-- 10. app_statistics
-- ============================================================
CREATE TABLE app_statistics (
    id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    stat_date              DATE UNIQUE NOT NULL,
    daily_active_users     INTEGER DEFAULT 0,
    peak_concurrent        INTEGER DEFAULT 0,
    total_matches          INTEGER DEFAULT 0,
    avg_session_duration_s INTEGER DEFAULT 0
);

-- ============================================================
-- 11. csam_reports
-- ============================================================
CREATE TABLE csam_reports (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    reporting_user_id UUID REFERENCES users(id),
    image_hash        TEXT NOT NULL,
    ip_address        TEXT,
    device_fingerprint TEXT,
    context           JSONB,
    reported_at       TIMESTAMP DEFAULT NOW(),
    reviewed          BOOLEAN DEFAULT FALSE,
    reviewed_by       UUID REFERENCES users(id),
    reviewed_at       TIMESTAMP
);

-- ============================================================
-- 12. blocked_users
-- ============================================================
CREATE TABLE blocked_users (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    blocker_id UUID REFERENCES users(id),
    blocked_id UUID REFERENCES users(id),
    type       block_type_enum,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(blocker_id, blocked_id)
);

-- ============================================================
-- 13. subscription_keys
-- ============================================================
CREATE TABLE subscription_keys (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    key         TEXT UNIQUE NOT NULL,
    created_at  TIMESTAMP DEFAULT NOW(),
    redeemed_by UUID REFERENCES users(id),
    redeemed_at TIMESTAMP
);

-- ============================================================
-- 14. image_blobs
-- ============================================================
-- Server stores only encrypted blobs — never plaintext.
-- Hybrid encryption: encrypted_blob encrypted with a random
-- symmetric key (crypto_secretbox); sealed_key is that symmetric
-- key sealed to the recipient's public key (crypto_box_seal).
-- Expiry and self-destruct scheduling are handled by messages.js.
CREATE TABLE image_blobs (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    uploader_id   UUID REFERENCES users(id)  NOT NULL,
    recipient_id  UUID REFERENCES users(id),           -- NULL for group images
    group_id      UUID REFERENCES groups(id),           -- NULL for DM images
    encrypted_blob TEXT NOT NULL,
    encryption_iv  TEXT NOT NULL,
    sealed_key     TEXT NOT NULL,
    created_at     TIMESTAMP DEFAULT NOW(),
    CHECK (
        (recipient_id IS NOT NULL AND group_id IS NULL) OR
        (recipient_id IS NULL     AND group_id IS NOT NULL)
    )
);

-- ============================================================
-- Indexes
-- ============================================================

-- users: lookups by username, matching filters, ban checks
CREATE INDEX idx_users_username        ON users (username);
CREATE INDEX idx_users_push_token      ON users (push_token) WHERE push_token IS NOT NULL;
CREATE INDEX idx_users_randoms_enabled ON users (randoms_enabled) WHERE randoms_enabled = TRUE;
CREATE INDEX idx_users_ban_type        ON users (ban_type) WHERE ban_type != 'none';
CREATE INDEX idx_users_tier            ON users (tier);
CREATE INDEX idx_users_gender          ON users (gender);
CREATE INDEX idx_users_location        ON users (location);
CREATE INDEX idx_users_age             ON users (age);

-- user_sessions: matching algorithm queries (avg return interval)
CREATE INDEX idx_user_sessions_user_id    ON user_sessions (user_id);
CREATE INDEX idx_user_sessions_started_at ON user_sessions (started_at);

-- profile_pictures: lookup by user
CREATE INDEX idx_profile_pictures_user_id ON profile_pictures (user_id);
CREATE INDEX idx_profile_pictures_uploaded_at ON profile_pictures (user_id, uploaded_at);

-- friends: lookup by either user, status filtering
CREATE INDEX idx_friends_user_id_1 ON friends (user_id_1);
CREATE INDEX idx_friends_user_id_2 ON friends (user_id_2);
CREATE INDEX idx_friends_status    ON friends (status);

-- messages: inbox queries, expiry cleanup, burn-after-read cleanup
CREATE INDEX idx_messages_recipient_id   ON messages (recipient_id);
CREATE INDEX idx_messages_sender_id      ON messages (sender_id);
CREATE INDEX idx_messages_group_id       ON messages (group_id);
CREATE INDEX idx_messages_created_at     ON messages (created_at);
CREATE INDEX idx_messages_expires_at     ON messages (expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX idx_messages_self_destruct  ON messages (self_destruct_at) WHERE self_destruct_at IS NOT NULL;

-- groups: lookup by creator
CREATE INDEX idx_groups_creator_id ON groups (creator_id);

-- group_members: lookup by group and user, active members
CREATE INDEX idx_group_members_group_id ON group_members (group_id);
CREATE INDEX idx_group_members_user_id  ON group_members (user_id);
CREATE INDEX idx_group_members_active   ON group_members (group_id, user_id) WHERE removed_at IS NULL;

-- group_pictures: lookup by group
CREATE INDEX idx_group_pictures_group_id ON group_pictures (group_id);
CREATE INDEX idx_group_pictures_uploaded_at ON group_pictures (group_id, uploaded_at);

-- purchases: lookup by user, status
CREATE INDEX idx_purchases_user_id ON purchases (user_id);
CREATE INDEX idx_purchases_status  ON purchases (status);

-- app_statistics: date range queries for matching algorithm
CREATE INDEX idx_app_statistics_stat_date ON app_statistics (stat_date);

-- csam_reports: lookup by user, review queue
CREATE INDEX idx_csam_reports_user_id  ON csam_reports (reporting_user_id);
CREATE INDEX idx_csam_reports_reviewed ON csam_reports (reviewed) WHERE reviewed = FALSE;

-- blocked_users: lookup by blocker and blocked
CREATE INDEX idx_blocked_users_blocker_id ON blocked_users (blocker_id);
CREATE INDEX idx_blocked_users_blocked_id ON blocked_users (blocked_id);

-- subscription_keys: fast lookup by key on redemption
CREATE INDEX idx_subscription_keys_key ON subscription_keys (key);

-- image_blobs: fetch by recipient, group, and uploader
CREATE INDEX idx_image_blobs_uploader_id  ON image_blobs (uploader_id);
CREATE INDEX idx_image_blobs_recipient_id ON image_blobs (recipient_id) WHERE recipient_id IS NOT NULL;
CREATE INDEX idx_image_blobs_group_id     ON image_blobs (group_id)     WHERE group_id     IS NOT NULL;

-- ============================================================
-- Triggers: auto-update updated_at columns
-- ============================================================
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_friends_updated_at
    BEFORE UPDATE ON friends
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_groups_updated_at
    BEFORE UPDATE ON groups
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
