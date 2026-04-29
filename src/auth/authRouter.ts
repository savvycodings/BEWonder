import crypto from 'crypto'
import express from 'express'
import type { PoolClient } from 'pg'
import { v2 as cloudinary } from 'cloudinary'
import { pool, runQuery } from '../db/client'
import {
  createSessionForUser,
  getAuthUserFromRequest,
  revokeSessionByToken,
} from './session'
import {
  claimWonderJumpChestForUser,
  getWonderJumpLeaderboard,
  getWonderJumpProgressForUser,
  mergeWonderJumpProgressForUser,
  pickupWonderJumpChestForUser,
} from './wonderJumpProgress'
import { ALLOWED_AVATAR_FRAMES, normalizeStoredAvatarFrameId } from '../constants/avatarFrames'
import { normalizeLegacyWonderBadgeId, WONDER_PROFILE_BADGE_IDS } from '../constants/wonderBadges'
import { runLoginStreakBump } from './dailyRewardsStreak'
import {
  fetchLocalDailyRewardSchedule,
  getClientTimeZoneFromRequest,
} from './dailyRewardsLocalSchedule'

const router = express.Router()
const DAILY_REWARD_AMOUNTS = [1, 2, 3, 4, 5, 6, 7]

/** Wonder Store item ids → cost in wonder coins (server is source of truth). */
const WONDER_STORE_ITEM_COSTS: Record<string, number> = {
  midnight: 6,
  sunset: 7,
  mint: 5,
  royal: 8,
  peach: 4,
  forest: 6,
  avatar_frame_neon: 5,
  avatar_frame_gold: 5,
  avatar_frame_rainbow: 5,
  avatar_frame_prism: 7,
  avatar_frame_meridian: 7,
  avatar_frame_hex: 12,
  avatar_frame_shard: 12,
  wonderjump_character_ghost: 10,
}

/** Normalized code key → wonder coins awarded (extend as you add codes). */
const REDEEM_CODE_REWARDS: Record<string, number> = {
  'WP-COMICCON': 10,
}

function normalizeRedeemCode(raw: string): string {
  return String(raw || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '')
}

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
})

function normalizeStoredAvatarFrame(raw: string | null | undefined): string {
  return normalizeStoredAvatarFrameId(raw)
}

type HeroBadgeSlots = [string | null, string | null, string | null]

function normalizeProfileBadgeSlots(raw: unknown): HeroBadgeSlots {
  if (!Array.isArray(raw)) return [null, null, null]
  const next = raw.slice(0, 3).map((v) => (typeof v === 'string' && v.trim() ? v.trim() : null))
  while (next.length < 3) next.push(null)
  return [next[0], next[1], next[2]] as HeroBadgeSlots
}

function normalizeProfileBannerUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const v = raw.trim()
  return v ? v : null
}

function isValidEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

function hashPassword(password: string) {
  const salt = crypto.randomBytes(16).toString('hex')
  const iterations = 100000
  const keyLength = 64
  const digest = 'sha512'
  const derivedKey = crypto
    .pbkdf2Sync(password, salt, iterations, keyLength, digest)
    .toString('hex')

  return `${salt}:${iterations}:${digest}:${derivedKey}`
}

function verifyPassword(password: string, storedHash: string) {
  const [salt, iterationsText, digest, storedDerivedKey] = storedHash.split(':')
  if (!salt || !iterationsText || !digest || !storedDerivedKey) {
    return false
  }

  const iterations = Number(iterationsText)
  if (!Number.isFinite(iterations) || iterations <= 0) {
    return false
  }

  const derivedKey = crypto
    .pbkdf2Sync(password, salt, iterations, 64, digest)
    .toString('hex')

  return crypto.timingSafeEqual(
    Buffer.from(derivedKey, 'hex'),
    Buffer.from(storedDerivedKey, 'hex')
  )
}

type DailyRewardRow = {
  claimed_count: number
  last_claimed_at: string
  login_streak_count: number
  login_streak_last_calendar_date: string | null
}

async function ensureDailyRewardRowTx(client: PoolClient, userId: string) {
  await client.query(
    `
      INSERT INTO user_daily_rewards (user_id, claimed_count, wallet_balance)
      VALUES ($1, 0, 0)
      ON CONFLICT (user_id) DO NOTHING
    `,
    [userId]
  )

  const rowResult = await client.query<DailyRewardRow>(
    `
      SELECT
        claimed_count,
        last_claimed_at,
        COALESCE(login_streak_count, 0)::int AS login_streak_count,
        login_streak_last_calendar_date::text AS login_streak_last_calendar_date
      FROM user_daily_rewards
      WHERE user_id = $1
      LIMIT 1
    `,
    [userId]
  )

  return rowResult.rows[0]
}

async function getPaidOrderCount(userId: string): Promise<number> {
  try {
    const r = await runQuery<{ c: string }>(
      `
        SELECT COUNT(*)::text AS c
        FROM orders
        WHERE user_id = $1 AND status = 'paid'
      `,
      [userId]
    )
    const raw = r.rows[0]?.c
    const n = raw != null ? parseInt(String(raw), 10) : 0
    return Number.isFinite(n) && n >= 0 ? n : 0
  } catch (e: any) {
    if (e?.code === '42P01') return 0
    throw e
  }
}

async function buildDailyRewardApiPayload(userId: string, row: DailyRewardRow, timeZone: string) {
  const maxDays = DAILY_REWARD_AMOUNTS.length
  const claimedCount = Math.max(0, Math.min(row.claimed_count, maxDays))
  const [wonderCoins, ownedStoreItemIds, paidOrderCount, schedule] = await Promise.all([
    getUserWonderCoins(userId),
    getOwnedWonderStoreItemIds(userId),
    getPaidOrderCount(userId),
    fetchLocalDailyRewardSchedule(pool, userId, timeZone, claimedCount, maxDays),
  ])
  return getDailyRewardPayload(row, wonderCoins, ownedStoreItemIds, paidOrderCount, schedule)
}

async function ensureDailyRewardRow(userId: string) {
  const client = await pool.connect()
  try {
    return await ensureDailyRewardRowTx(client, userId)
  } finally {
    client.release()
  }
}

async function getUserWonderCoins(userId: string): Promise<number> {
  const r = await runQuery<{ wonder_coins: number }>(
    `
      SELECT wonder_coins
      FROM users
      WHERE id::text = $1
      LIMIT 1
    `,
    [userId]
  )
  const v = r.rows[0]?.wonder_coins
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

async function getOwnedWonderStoreItemIds(userId: string): Promise<string[]> {
  const r = await runQuery<{ item_id: string }>(
    `
      SELECT item_id
      FROM user_wonder_store_purchases
      WHERE user_id = $1
      ORDER BY created_at ASC
    `,
    [userId]
  )
  return r.rows.map((row) => row.item_id)
}

function getDailyRewardPayload(
  row: DailyRewardRow,
  wonderCoins: number,
  ownedStoreItemIds: string[],
  paidOrderCount: number,
  schedule: { canClaimByLocalCalendar: boolean; nextUnlockAt: string | null },
) {
  const maxDays = DAILY_REWARD_AMOUNTS.length
  const claimedCount = Math.max(0, Math.min(row.claimed_count, maxDays))
  const hasCompletedAllRewards = claimedCount >= maxDays
  const canClaim = !hasCompletedAllRewards && schedule.canClaimByLocalCalendar
  const nextUnlockAt =
    hasCompletedAllRewards || claimedCount === 0 ? null : schedule.nextUnlockAt

  const loginStreak =
    typeof row.login_streak_count === 'number' && Number.isFinite(row.login_streak_count)
      ? Math.max(0, Math.floor(row.login_streak_count))
      : 0

  return {
    walletBalance: wonderCoins,
    ownedStoreItemIds,
    claimedCount,
    /** Consecutive local-calendar-day streak (client `X-User-Timezone`; claims + Daily Rewards after day 7). */
    currentStreakDays: loginStreak,
    paidOrderCount,
    canClaim,
    nextUnlockAt,
    rewards: DAILY_REWARD_AMOUNTS.map((amount, index) => {
      const day = index + 1
      let status: 'claimed' | 'unlocked' | 'locked' = 'locked'
      if (day <= claimedCount) {
        status = 'claimed'
      } else if (day === claimedCount + 1 && canClaim) {
        status = 'unlocked'
      }
      return { day, amount, status }
    }),
  }
}

async function userEarnsProfileBadge(userId: string, badgeId: string): Promise<boolean> {
  if (badgeId === 'badge:heart') return true
  const row = await ensureDailyRewardRow(userId)
  if (!row) return false
  const paid = await getPaidOrderCount(userId)
  const streak =
    typeof row.login_streak_count === 'number' && Number.isFinite(row.login_streak_count)
      ? Math.max(0, Math.floor(row.login_streak_count))
      : 0
  const claimed = Math.max(0, Math.floor(row.claimed_count))

  switch (badgeId) {
    case 'badge:day7':
      return claimed >= 7
    case 'badge:day30':
      return streak >= 30
    case 'badge:day90':
      return streak >= 90
    case 'badge:order1':
      return paid >= 1
    case 'badge:order5':
      return paid >= 5
    case 'badge:order10':
      return paid >= 10
    default:
      return false
  }
}

router.post('/register', async (req, res) => {
  const fullName = String(req.body?.fullName || '').trim()
  const email = String(req.body?.email || '').trim().toLowerCase()
  const password = String(req.body?.password || '')
  const phone = String(req.body?.phone || '').trim()
  const shippingAddress = String(req.body?.shippingAddress || '').trim()
  const shippingAddressLine2 = String(req.body?.shippingAddressLine2 || '').trim()
  const pudoLockerName = String(req.body?.pudoLockerName || '').trim()
  const pudoLockerAddress = String(req.body?.pudoLockerAddress || '').trim()
  const eftBankAccountName = String(req.body?.eftBankAccountName || '').trim()
  const eftBankName = String(req.body?.eftBankName || '').trim()
  const eftBankAccountNumber = String(req.body?.eftBankAccountNumber || '').trim()
  const eftBankBranch = String(req.body?.eftBankBranch || '').trim()
  console.log('[auth/register] incoming request', {
    email,
    fullNameLength: fullName.length,
    passwordLength: password.length,
    hasPhone: Boolean(phone),
  })

  if (!fullName || !email || !password) {
    return res.status(400).json({
      error: 'fullName, email, and password are required',
    })
  }

  if (!phone) {
    return res.status(400).json({ error: 'phone is required' })
  }
  const phoneDigits = phone.replace(/\D/g, '')
  if (phoneDigits.length < 9) {
    return res.status(400).json({ error: 'Please enter a valid cellphone number' })
  }

  if (!isValidEmail(email)) {
    return res.status(400).json({
      error: 'Email address is invalid',
    })
  }

  if (password.length < 8) {
    return res.status(400).json({
      error: 'Password must be at least 8 characters',
    })
  }

  const passwordHash = hashPassword(password)

  try {
    const result = await runQuery<{
      id: string
      email: string
      created_at: string
      name: string | null
      image: string | null
      shipping_address1: string | null
      shipping_address2: string | null
      phone: string | null
      pudo_locker_name: string | null
      pudo_locker_address: string | null
      eft_bank_account_name: string | null
      eft_bank_name: string | null
      eft_bank_account_number: string | null
      eft_bank_branch: string | null
      avatar_frame: string | null
    }>(
      `
        INSERT INTO users (
          id,
          email,
          name,
          image,
          shipping_address1,
          shipping_address2,
          phone,
          pudo_locker_name,
          pudo_locker_address,
          eft_bank_account_name,
          eft_bank_name,
          eft_bank_account_number,
          eft_bank_branch,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW(), NOW())
        RETURNING
          id,
          email,
          created_at,
          name,
          image,
          shipping_address1,
          shipping_address2,
          phone,
          pudo_locker_name,
          pudo_locker_address,
          eft_bank_account_name,
          eft_bank_name,
          eft_bank_account_number,
          eft_bank_branch,
          avatar_frame
      `,
      [
        crypto.randomUUID(),
        email,
        fullName,
        null,
        shippingAddress || null,
        shippingAddressLine2 || null,
        phone,
        pudoLockerName || null,
        pudoLockerAddress || null,
        eftBankAccountName || null,
        eftBankName || null,
        eftBankAccountNumber || null,
        eftBankBranch || null,
      ]
    )

    const user = result.rows[0]

    // Store password hash in an account record.
    // This keeps us aligned to the existing Better Auth-style tables without changing Neon schema.
    // (We’re effectively implementing an internal "password" provider.)
    await runQuery(
      `
        INSERT INTO accounts (
          id,
          user_id,
          provider_id,
          provider_user_id,
          access_token,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
      `,
      [crypto.randomUUID(), user.id, 'password', email, passwordHash]
    )

    const sessionToken = await createSessionForUser(user.id)
    try {
      await ensureDailyRewardRow(user.id)
    } catch (e) {
      console.warn('[auth/register] daily rewards row skipped', e)
    }
    console.log('[auth/register] user created', {
      id: user.id,
      email: user.email,
    })
    return res.status(201).json({
      user: {
        id: user.id,
        fullName: user.name || '',
        email: user.email,
        createdAt: user.created_at,
        profilePicture: user.image,
        shippingAddress: user.shipping_address1,
        shippingAddressLine2: user.shipping_address2,
        phone: user.phone,
        pudoLockerName: user.pudo_locker_name,
        pudoLockerAddress: user.pudo_locker_address,
        eftBankAccountName: user.eft_bank_account_name,
        eftBankName: user.eft_bank_name,
        eftBankAccountNumber: user.eft_bank_account_number,
        eftBankBranch: user.eft_bank_branch,
        avatarFrameId: normalizeStoredAvatarFrame(user.avatar_frame),
        paymentMethod: null,
      },
      sessionToken,
    })
  } catch (error: any) {
    if (error?.code === '23505') {
      console.log('[auth/register] duplicate email', { email })
      return res.status(409).json({
        error: 'A user with this email already exists',
      })
    }
    if (error?.code === '42703') {
      return res.status(503).json({
        error: 'Database is missing new profile columns',
        detail: 'Run server migration: pnpm db:migrate (or apply schema.sql) so users.phone and related columns exist.',
      })
    }

    console.error('Failed to register user', error)
    return res.status(500).json({
      error: 'Unable to create user',
    })
  }
})

router.post('/login', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase()
  const password = String(req.body?.password || '')
  console.log('[auth/login] incoming request', {
    email,
    passwordLength: password.length,
  })

  if (!email || !password) {
    return res.status(400).json({
      error: 'email and password are required',
    })
  }

  try {
    const accountResult = await runQuery<{
      user_id: string
      access_token: string | null
    }>(
      `
        SELECT user_id, access_token
        FROM accounts
        WHERE provider_id = 'password'
          AND provider_user_id = $1
        LIMIT 1
      `,
      [email]
    )

    const account = accountResult.rows[0]
    if (!account?.access_token || !verifyPassword(password, account.access_token)) {
      return res.status(401).json({
        error: 'Invalid email or password',
      })
    }

    const userResult = await runQuery<{
      id: string
      email: string
      created_at: string
      name: string | null
      image: string | null
      shipping_address1: string | null
      shipping_address2: string | null
      phone: string | null
      pudo_locker_name: string | null
      pudo_locker_address: string | null
      eft_bank_account_name: string | null
      eft_bank_name: string | null
      eft_bank_account_number: string | null
      eft_bank_branch: string | null
      avatar_frame: string | null
    }>(
      `
        SELECT
          id,
          email,
          created_at,
          name,
          image,
          shipping_address1,
          shipping_address2,
          phone,
          pudo_locker_name,
          pudo_locker_address,
          eft_bank_account_name,
          eft_bank_name,
          eft_bank_account_number,
          eft_bank_branch,
          avatar_frame
        FROM users
        WHERE id = $1
        LIMIT 1
      `,
      [account.user_id]
    )

    const user = userResult.rows[0]
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' })
    }

    console.log('[auth/login] user authenticated', {
      id: user.id,
      email: user.email,
    })
    const sessionToken = await createSessionForUser(user.id)

    return res.status(200).json({
      user: {
        id: user.id,
        fullName: user.name || '',
        email: user.email,
        createdAt: user.created_at,
        profilePicture: user.image,
        shippingAddress: user.shipping_address1,
        shippingAddressLine2: user.shipping_address2,
        phone: user.phone,
        pudoLockerName: user.pudo_locker_name,
        pudoLockerAddress: user.pudo_locker_address,
        eftBankAccountName: user.eft_bank_account_name,
        eftBankName: user.eft_bank_name,
        eftBankAccountNumber: user.eft_bank_account_number,
        eftBankBranch: user.eft_bank_branch,
        avatarFrameId: normalizeStoredAvatarFrame(user.avatar_frame),
        paymentMethod: null,
      },
      sessionToken,
    })
  } catch (error) {
    console.error('Failed to login user', error)
    return res.status(500).json({
      error: 'Unable to sign in',
    })
  }
})

router.get('/me', async (req, res) => {
  const auth = await getAuthUserFromRequest(req)
  if (!auth) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  return res.status(200).json({ user: auth.user })
})

router.post('/redeem-code', async (req, res) => {
  const auth = await getAuthUserFromRequest(req)
  if (!auth) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const codeKey = normalizeRedeemCode(String(req.body?.code || ''))
  if (!codeKey) {
    return res.status(400).json({ error: 'Enter a code to redeem.' })
  }

  const coins = REDEEM_CODE_REWARDS[codeKey]
  if (coins == null) {
    return res.status(400).json({ error: 'Invalid or unknown code.' })
  }

  const userId = auth.userId
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    const ins = await client.query<{ id: string }>(
      `
        INSERT INTO user_redeem_codes (user_id, code_key, coins_awarded)
        VALUES ($1, $2, $3)
        ON CONFLICT (user_id, code_key) DO NOTHING
        RETURNING id
      `,
      [userId, codeKey, coins]
    )

    if (!ins.rows[0]) {
      await client.query('ROLLBACK')
      return res.status(409).json({ error: 'You have already redeemed this code.' })
    }

    const bal = await client.query<{ wonder_coins: number }>(
      `
        UPDATE users
        SET wonder_coins = wonder_coins + $2, updated_at = NOW()
        WHERE id::text = $1
        RETURNING wonder_coins
      `,
      [userId, coins]
    )

    if (!bal.rows[0]) {
      await client.query('ROLLBACK')
      return res.status(500).json({ error: 'Unable to apply reward' })
    }

    await client.query('COMMIT')

    return res.status(200).json({
      wonderCoins: bal.rows[0].wonder_coins,
      message: `You received ${coins} Wonder coins.`,
    })
  } catch (error: any) {
    try {
      await client.query('ROLLBACK')
    } catch {
      /* ignore */
    }
    if (error?.code === '42P01') {
      return res.status(503).json({
        error: 'Redeem is not available yet',
        detail: 'Run db:migrate so user_redeem_codes exists.',
      })
    }
    console.error('Failed to redeem code', error)
    return res.status(500).json({ error: 'Unable to redeem code' })
  } finally {
    client.release()
  }
})

router.post('/logout', async (req, res) => {
  const auth = await getAuthUserFromRequest(req)
  if (!auth) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  await revokeSessionByToken(auth.token)
  return res.status(200).json({ ok: true })
})

router.get('/daily-rewards', async (req, res) => {
  const auth = await getAuthUserFromRequest(req)
  if (!auth) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const tz = getClientTimeZoneFromRequest(req)

  try {
    let row = await ensureDailyRewardRow(auth.userId)
    if (!row) {
      return res.status(500).json({ error: 'Unable to load daily rewards' })
    }
    const maxDays = DAILY_REWARD_AMOUNTS.length
    if (row.claimed_count >= maxDays) {
      try {
        await runLoginStreakBump(pool, auth.userId, true, tz)
      } catch (e: any) {
        if (e?.code !== '42703') throw e
      }
      row = (await ensureDailyRewardRow(auth.userId)) ?? row
    }

    return res.status(200).json(await buildDailyRewardApiPayload(auth.userId, row, tz))
  } catch (error) {
    console.error('Failed to load daily rewards', error)
    return res.status(500).json({ error: 'Unable to load daily rewards' })
  }
})

router.post('/daily-rewards/claim', async (req, res) => {
  const auth = await getAuthUserFromRequest(req)
  if (!auth) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const userId = auth.userId
  const maxDays = DAILY_REWARD_AMOUNTS.length
  const tz = getClientTimeZoneFromRequest(req)

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await ensureDailyRewardRowTx(client, userId)

    const updateResult = await client.query<DailyRewardRow>(
      `
        UPDATE user_daily_rewards
        SET
          claimed_count = LEAST(claimed_count + 1, $2),
          last_claimed_at = NOW(),
          updated_at = NOW()
        WHERE user_id = $1
          AND claimed_count < $2
          AND (
            claimed_count = 0
            OR (last_claimed_at AT TIME ZONE $3)::date < (CURRENT_TIMESTAMP AT TIME ZONE $3)::date
          )
        RETURNING claimed_count, last_claimed_at
      `,
      [userId, maxDays, tz]
    )

    const updatedRow = updateResult.rows[0]
    if (!updatedRow) {
      await client.query('ROLLBACK')
      const currentRow = await ensureDailyRewardRow(userId)
      if (!currentRow) {
        return res.status(500).json({ error: 'Unable to load claim status' })
      }
      return res.status(409).json({
        error: 'Reward is not unlocked yet',
        ...(await buildDailyRewardApiPayload(userId, currentRow, tz)),
      })
    }

    const newClaimed = Math.max(1, Math.min(updatedRow.claimed_count, maxDays))
    const coinsAdded = DAILY_REWARD_AMOUNTS[newClaimed - 1] ?? newClaimed

    await client.query(
      `
        UPDATE users
        SET wonder_coins = wonder_coins + $2, updated_at = NOW()
        WHERE id::text = $1
      `,
      [userId, coinsAdded]
    )

    try {
      await runLoginStreakBump(client, userId, false, tz)
    } catch (e: any) {
      if (e?.code !== '42703') throw e
    }

    const fullRow = await client.query<DailyRewardRow>(
      `
        SELECT
          claimed_count,
          last_claimed_at,
          COALESCE(login_streak_count, 0)::int AS login_streak_count,
          login_streak_last_calendar_date::text AS login_streak_last_calendar_date
        FROM user_daily_rewards
        WHERE user_id = $1
        LIMIT 1
      `,
      [userId]
    )
    const payloadRow = fullRow.rows[0]
    if (!payloadRow) {
      await client.query('ROLLBACK')
      return res.status(500).json({ error: 'Unable to load rewards after claim' })
    }

    await client.query('COMMIT')

    return res.status(200).json(await buildDailyRewardApiPayload(userId, payloadRow, tz))
  } catch (error) {
    try {
      await client.query('ROLLBACK')
    } catch {
      /* ignore */
    }
    console.error('Failed to claim daily reward', error)
    return res.status(500).json({ error: 'Unable to claim daily reward' })
  } finally {
    client.release()
  }
})

/** Public: anyone can view WonderJump high scores (no session required). */
router.get('/wonder-jump-leaderboard', async (req, res) => {
  const raw = Number(req.query.limit)
  const limit = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 50
  try {
    const entries = await getWonderJumpLeaderboard(limit)
    return res.status(200).json({ entries })
  } catch (error: any) {
    if (error?.code === '42P01' || error?.code === '42703') {
      return res.status(200).json({ entries: [], degraded: true as const })
    }
    console.error('Failed to load WonderJump leaderboard', error)
    return res.status(500).json({ error: 'Unable to load leaderboard', entries: [] })
  }
})

router.get('/wonder-jump-progress', async (_req, res) => {
  const auth = await getAuthUserFromRequest(_req)
  if (!auth) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  try {
    const data = await getWonderJumpProgressForUser(auth.userId)
    return res.status(200).json(data)
  } catch (error: any) {
    if (error?.code === '42P01') {
      return res.status(503).json({
        error: 'WonderJump progress is not available yet',
        detail: 'Run pnpm db:migrate so user_wonder_jump_progress exists.',
      })
    }
    console.error('Failed to load WonderJump progress', error)
    return res.status(500).json({ error: 'Unable to load WonderJump progress' })
  }
})

router.put('/wonder-jump-progress', async (req, res) => {
  const auth = await getAuthUserFromRequest(req)
  if (!auth) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  try {
    const data = await mergeWonderJumpProgressForUser(auth.userId, req.body || {})
    return res.status(200).json(data)
  } catch (error: any) {
    if (error?.code === '42P01') {
      return res.status(503).json({
        error: 'WonderJump progress is not available yet',
        detail: 'Run pnpm db:migrate so user_wonder_jump_progress exists.',
      })
    }
    console.error('Failed to save WonderJump progress', error)
    return res.status(500).json({ error: 'Unable to save WonderJump progress' })
  }
})

router.post('/wonder-jump-chest/pickup', async (_req, res) => {
  const auth = await getAuthUserFromRequest(_req)
  if (!auth) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  try {
    const data = await pickupWonderJumpChestForUser(auth.userId)
    return res.status(200).json(data)
  } catch (error: any) {
    if (error?.code === '42P01' || error?.code === '42703') {
      return res.status(503).json({
        error: 'WonderJump chest is not available yet',
        detail: 'Run pnpm db:migrate (wonder_jump_chest_unlocks_at column).',
      })
    }
    console.error('Failed to record WonderJump chest pickup', error)
    return res.status(500).json({ error: 'Unable to record chest pickup' })
  }
})

router.post('/wonder-jump-chest/claim', async (_req, res) => {
  const auth = await getAuthUserFromRequest(_req)
  if (!auth) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  try {
    const result = await claimWonderJumpChestForUser(auth.userId)
    if (!result.ok) {
      const body: Record<string, unknown> = { error: result.message }
      if (result.chestUnlocksAt != null) body.chestUnlocksAt = result.chestUnlocksAt
      if (result.msRemaining != null) body.msRemaining = result.msRemaining
      return res.status(result.status).json(body)
    }
    return res.status(200).json({
      ok: true,
      wonderCoins: result.wonderCoins,
      chestUnlocksAt: null,
    })
  } catch (error: any) {
    if (error?.code === '42P01' || error?.code === '42703') {
      return res.status(503).json({
        error: 'WonderJump chest is not available yet',
        detail: 'Run pnpm db:migrate (wonder_jump_chest_unlocks_at column).',
      })
    }
    console.error('Failed to claim WonderJump chest', error)
    return res.status(500).json({ error: 'Unable to claim chest' })
  }
})

router.post('/wonder-store/purchase', async (req, res) => {
  const auth = await getAuthUserFromRequest(req)
  if (!auth) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const userId = auth.userId
  const tz = getClientTimeZoneFromRequest(req)
  const itemId = String(req.body?.itemId || '').trim().toLowerCase()
  const cost = WONDER_STORE_ITEM_COSTS[itemId]
  if (!itemId || cost == null) {
    return res.status(400).json({ error: 'Invalid store item' })
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    const dup = await client.query<{ n: string }>(
      `SELECT 1 AS n FROM user_wonder_store_purchases WHERE user_id = $1 AND item_id = $2 LIMIT 1`,
      [userId, itemId]
    )
    if (dup.rows.length > 0) {
      await client.query('ROLLBACK')
      const row = await ensureDailyRewardRow(userId)
      if (!row) {
        return res.status(500).json({ error: 'Unable to load rewards' })
      }
      return res.status(409).json({
        error: 'Already purchased',
        ...(await buildDailyRewardApiPayload(userId, row, tz)),
      })
    }

    const spend = await client.query<{ wonder_coins: number }>(
      `
        UPDATE users
        SET wonder_coins = wonder_coins - $2, updated_at = NOW()
        WHERE id::text = $1
          AND wonder_coins >= $2
        RETURNING wonder_coins
      `,
      [userId, cost]
    )

    if (!spend.rows[0]) {
      await client.query('ROLLBACK')
      const row = await ensureDailyRewardRow(userId)
      if (!row) {
        return res.status(500).json({ error: 'Unable to load rewards' })
      }
      return res.status(402).json({
        error: 'Not enough coins',
        ...(await buildDailyRewardApiPayload(userId, row, tz)),
      })
    }

    await client.query(
      `
        INSERT INTO user_wonder_store_purchases (user_id, item_id, cost_coins)
        VALUES ($1, $2, $3)
      `,
      [userId, itemId, cost]
    )

    await client.query('COMMIT')

    const row = await ensureDailyRewardRow(userId)
    if (!row) {
      return res.status(500).json({ error: 'Unable to load rewards' })
    }
    return res.status(200).json(await buildDailyRewardApiPayload(userId, row, tz))
  } catch (error) {
    try {
      await client.query('ROLLBACK')
    } catch {
      /* ignore */
    }
    console.error('Failed wonder store purchase', error)
    return res.status(500).json({ error: 'Unable to complete purchase' })
  } finally {
    client.release()
  }
})

router.post('/profile-picture', async (req, res) => {
  const auth = await getAuthUserFromRequest(req)
  if (!auth) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const userId = auth.userId
  const imageBase64 = String(req.body?.imageBase64 || '').trim()
  const mimeType = String(req.body?.mimeType || 'image/jpeg').trim()

  if (!imageBase64) {
    return res.status(400).json({
      error: 'imageBase64 is required',
    })
  }

  if (
    !process.env.CLOUDINARY_CLOUD_NAME ||
    !process.env.CLOUDINARY_API_KEY ||
    !process.env.CLOUDINARY_API_SECRET
  ) {
    return res.status(500).json({
      error: 'Cloudinary environment variables are not configured',
    })
  }

  try {
    const uploadResult = await cloudinary.uploader.upload(
      `data:${mimeType};base64,${imageBase64}`,
      {
        folder: 'wonderport/profile-pictures',
        public_id: `user-${userId}-${Date.now()}`,
        resource_type: 'image',
        overwrite: true,
      }
    )

    const result = await runQuery<{
      id: string
      email: string
      created_at: string
      name: string | null
      image: string | null
      shipping_address1: string | null
    }>(
      `
        UPDATE users
        SET image = $2, updated_at = NOW()
        WHERE id = $1
        RETURNING
          id,
          email,
          created_at,
          name,
          image,
          shipping_address1
      `,
      [userId, uploadResult.secure_url]
    )

    if (!result.rows[0]) {
      return res.status(404).json({
        error: 'User not found',
      })
    }

    const user = result.rows[0]
    return res.status(200).json({
      user: {
        id: user.id,
        fullName: user.name || '',
        email: user.email,
        createdAt: user.created_at,
        profilePicture: user.image,
        shippingAddress: user.shipping_address1,
        paymentMethod: null,
      },
    })
  } catch (error) {
    console.error('Failed to upload profile picture', error)
    return res.status(500).json({
      error: 'Unable to upload profile picture',
    })
  }
})

router.patch('/profile-details', async (req, res) => {
  const auth = await getAuthUserFromRequest(req)
  if (!auth) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const b = req.body || {}
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : undefined)
  const nextName = str(b.fullName)
  const nextEmailRaw = str(b.email)
  const nextEmail = nextEmailRaw ? nextEmailRaw.toLowerCase() : undefined

  if (nextName !== undefined && !nextName) {
    return res.status(400).json({ error: 'fullName cannot be empty' })
  }
  if (nextEmail !== undefined) {
    if (!nextEmail) return res.status(400).json({ error: 'email cannot be empty' })
    if (!isValidEmail(nextEmail)) {
      return res.status(400).json({ error: 'Email address is invalid' })
    }
  }

  const sets: string[] = []
  const vals: unknown[] = [auth.userId]
  let i = 2

  const add = (col: string, value: string | null | undefined) => {
    if (value === undefined) return
    sets.push(`${col} = $${i}`)
    vals.push(value === '' ? null : value)
    i += 1
  }

  add('shipping_address1', str(b.shippingAddress))
  add('shipping_address2', str(b.shippingAddressLine2))
  add('name', nextName)
  add('email', nextEmail)
  add('phone', str(b.phone))
  add('pudo_locker_name', str(b.pudoLockerName))
  add('pudo_locker_address', str(b.pudoLockerAddress))
  add('eft_bank_account_name', str(b.eftBankAccountName))
  add('eft_bank_name', str(b.eftBankName))
  add('eft_bank_account_number', str(b.eftBankAccountNumber))
  add('eft_bank_branch', str(b.eftBankBranch))

  if (!sets.length) {
    return res.status(400).json({ error: 'No supported fields to update' })
  }

  try {
    const result = await runQuery<{
      id: string
      email: string
      created_at: string
      name: string | null
      image: string | null
      shipping_address1: string | null
      shipping_address2: string | null
      phone: string | null
      pudo_locker_name: string | null
      pudo_locker_address: string | null
      eft_bank_account_name: string | null
      eft_bank_name: string | null
      eft_bank_account_number: string | null
      eft_bank_branch: string | null
      avatar_frame: string | null
    }>(
      `
        UPDATE users
        SET
          ${sets.join(', ')},
          updated_at = NOW()
        WHERE id = $1
        RETURNING
          id,
          email,
          created_at,
          name,
          image,
          shipping_address1,
          shipping_address2,
          phone,
          pudo_locker_name,
          pudo_locker_address,
          eft_bank_account_name,
          eft_bank_name,
          eft_bank_account_number,
          eft_bank_branch,
          avatar_frame
      `,
      vals
    )

    const user = result.rows[0]
    if (!user) {
      return res.status(404).json({ error: 'User not found' })
    }

    // Keep password provider login in sync if email changed.
    if (nextEmail && nextEmail !== auth.user.email.toLowerCase()) {
      await runQuery(
        `
          UPDATE accounts
          SET provider_user_id = $2, updated_at = NOW()
          WHERE user_id = $1
            AND provider_id = 'password'
        `,
        [auth.userId, nextEmail]
      )
    }

    return res.status(200).json({
      user: {
        id: user.id,
        fullName: user.name || '',
        email: user.email,
        createdAt: user.created_at,
        profilePicture: user.image,
        shippingAddress: user.shipping_address1,
        shippingAddressLine2: user.shipping_address2,
        phone: user.phone,
        pudoLockerName: user.pudo_locker_name,
        pudoLockerAddress: user.pudo_locker_address,
        eftBankAccountName: user.eft_bank_account_name,
        eftBankName: user.eft_bank_name,
        eftBankAccountNumber: user.eft_bank_account_number,
        eftBankBranch: user.eft_bank_branch,
        avatarFrameId: normalizeStoredAvatarFrame(user.avatar_frame),
        paymentMethod: null,
      },
    })
  } catch (error: any) {
    if (error?.code === '23505') {
      return res.status(409).json({
        error: 'A user with this email already exists',
      })
    }
    console.error('Failed to update profile details', error)
    return res.status(500).json({
      error: 'Unable to update profile details',
    })
  }
})

router.patch('/avatar-frame', async (req, res) => {
  const auth = await getAuthUserFromRequest(req)
  if (!auth) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const raw = String(req.body?.avatarFrameId ?? req.body?.frameId ?? '').trim()
  if (!ALLOWED_AVATAR_FRAMES.has(raw)) {
    return res.status(400).json({ error: 'Invalid avatar frame' })
  }

  if (raw !== 'none') {
    const storeKey = `avatar_frame_${raw}`
    if (WONDER_STORE_ITEM_COSTS[storeKey] != null) {
      const own = await runQuery<{ n: number }>(
        `
          SELECT 1 AS n
          FROM user_wonder_store_purchases
          WHERE user_id = $1 AND item_id = $2
          LIMIT 1
        `,
        [auth.userId, storeKey]
      )
      if (own.rows.length === 0) {
        return res.status(403).json({
          error: 'Purchase this frame in the Wonder Store first.',
        })
      }
    }
  }

  try {
    const result = await runQuery<{ avatar_frame: string | null }>(
      `
        UPDATE users
        SET avatar_frame = $2, updated_at = NOW()
        WHERE id = $1
        RETURNING avatar_frame
      `,
      [auth.userId, raw]
    )

    const row = result.rows[0]
    const avatarFrameId = normalizeStoredAvatarFrame(row?.avatar_frame)

    return res.status(200).json({
      user: {
        ...auth.user,
        avatarFrameId,
      },
    })
  } catch (error: any) {
    if (error?.code === '42703') {
      return res.status(503).json({
        error: 'Avatar frames require a database update on this server.',
      })
    }
    console.error('Failed to update avatar frame', error)
    return res.status(500).json({ error: 'Unable to update avatar frame' })
  }
})

router.get('/profile-hero', async (req, res) => {
  const auth = await getAuthUserFromRequest(req)
  if (!auth) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  try {
    const result = await runQuery<{ profile_banner_url: string | null; profile_badge_slots: unknown }>(
      `
        SELECT profile_banner_url, profile_badge_slots
        FROM users
        WHERE id::text = $1
        LIMIT 1
      `,
      [auth.userId]
    )
    const row = result.rows[0]
    if (!row) {
      return res.status(404).json({ error: 'User not found' })
    }
    return res.status(200).json({
      bannerUrl: normalizeProfileBannerUrl(row.profile_banner_url),
      badgeSlots: normalizeProfileBadgeSlots(row.profile_badge_slots),
    })
  } catch (error: any) {
    if (error?.code === '42703') {
      return res.status(503).json({
        error: 'Profile hero fields need a database update on this server.',
      })
    }
    console.error('Failed to load profile hero', error)
    return res.status(500).json({ error: 'Unable to load profile hero' })
  }
})

router.patch('/profile-hero', async (req, res) => {
  const auth = await getAuthUserFromRequest(req)
  if (!auth) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const bannerUrl =
    req.body?.bannerUrl === undefined ? undefined : normalizeProfileBannerUrl(String(req.body?.bannerUrl ?? ''))
  const rawBadgeSlots =
    req.body?.badgeSlots === undefined ? undefined : normalizeProfileBadgeSlots(req.body?.badgeSlots)

  if (bannerUrl === undefined && rawBadgeSlots === undefined) {
    return res.status(400).json({ error: 'No supported profile hero fields to update' })
  }

  let badgeSlotsToSave: HeroBadgeSlots | undefined
  if (rawBadgeSlots !== undefined) {
    badgeSlotsToSave = [
      rawBadgeSlots[0] ? normalizeLegacyWonderBadgeId(rawBadgeSlots[0]) : null,
      rawBadgeSlots[1] ? normalizeLegacyWonderBadgeId(rawBadgeSlots[1]) : null,
      rawBadgeSlots[2] ? normalizeLegacyWonderBadgeId(rawBadgeSlots[2]) : null,
    ] as HeroBadgeSlots
    for (const b of badgeSlotsToSave) {
      if (!b) continue
      if (!WONDER_PROFILE_BADGE_IDS.has(b)) {
        return res.status(400).json({ error: 'Invalid badge id' })
      }
      const allowed = await userEarnsProfileBadge(auth.userId, b)
      if (!allowed) {
        return res.status(400).json({ error: 'Badge is not unlocked yet' })
      }
    }
  }

  const sets: string[] = []
  const vals: unknown[] = [auth.userId]
  let i = 2
  if (bannerUrl !== undefined) {
    sets.push(`profile_banner_url = $${i}`)
    vals.push(bannerUrl)
    i += 1
  }
  if (badgeSlotsToSave !== undefined) {
    sets.push(`profile_badge_slots = $${i}::jsonb`)
    vals.push(JSON.stringify(badgeSlotsToSave))
    i += 1
  }

  try {
    const result = await runQuery<{ profile_banner_url: string | null; profile_badge_slots: unknown }>(
      `
        UPDATE users
        SET ${sets.join(', ')}, updated_at = NOW()
        WHERE id::text = $1
        RETURNING profile_banner_url, profile_badge_slots
      `,
      vals
    )
    const row = result.rows[0]
    if (!row) {
      return res.status(404).json({ error: 'User not found' })
    }
    return res.status(200).json({
      bannerUrl: normalizeProfileBannerUrl(row.profile_banner_url),
      badgeSlots: normalizeProfileBadgeSlots(row.profile_badge_slots),
    })
  } catch (error: any) {
    if (error?.code === '42703') {
      return res.status(503).json({
        error: 'Profile hero fields need a database update on this server.',
      })
    }
    console.error('Failed to update profile hero', error)
    return res.status(500).json({ error: 'Unable to update profile hero' })
  }
})

router.post('/profile-banner', async (req, res) => {
  const auth = await getAuthUserFromRequest(req)
  if (!auth) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  const imageBase64 = String(req.body?.imageBase64 || '').trim()
  const mimeType = String(req.body?.mimeType || 'image/jpeg').trim()
  if (!imageBase64) {
    return res.status(400).json({ error: 'imageBase64 is required' })
  }
  if (
    !process.env.CLOUDINARY_CLOUD_NAME ||
    !process.env.CLOUDINARY_API_KEY ||
    !process.env.CLOUDINARY_API_SECRET
  ) {
    return res.status(500).json({
      error: 'Cloudinary environment variables are not configured',
    })
  }
  try {
    const uploadResult = await cloudinary.uploader.upload(
      `data:${mimeType};base64,${imageBase64}`,
      {
        folder: 'wonderport/profile-banners',
        public_id: `banner-${auth.userId}-${Date.now()}`,
        resource_type: 'image',
        overwrite: true,
      }
    )
    const bannerUrl = String(uploadResult.secure_url || '').trim()
    await runQuery(
      `
        UPDATE users
        SET profile_banner_url = $2, updated_at = NOW()
        WHERE id::text = $1
      `,
      [auth.userId, bannerUrl || null]
    )
    return res.status(200).json({ bannerUrl: bannerUrl || null })
  } catch (error) {
    console.error('Failed to upload profile banner', error)
    return res.status(500).json({ error: 'Unable to upload profile banner' })
  }
})

router.get('/community/users/:userId/public', async (req, res) => {
  const auth = await getAuthUserFromRequest(req)
  if (!auth) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  const userId = String(req.params.userId || '').trim()
  if (!userId) {
    return res.status(400).json({ error: 'userId is required' })
  }
  try {
    const result = await runQuery<{
      profile_banner_url: string | null
      profile_badge_slots: unknown
    }>(
      `
        SELECT profile_banner_url, profile_badge_slots
        FROM users
        WHERE id::text = $1
        LIMIT 1
      `,
      [userId]
    )
    const row = result.rows[0]
    if (!row) return res.status(404).json({ error: 'User not found' })
    return res.status(200).json({
      bannerUrl: normalizeProfileBannerUrl(row.profile_banner_url),
      badgeSlots: normalizeProfileBadgeSlots(row.profile_badge_slots),
      bio: null,
      tagline: null,
    })
  } catch (error: any) {
    if (error?.code === '42703') {
      return res.status(503).json({
        error: 'Community profile fields need a database update on this server.',
      })
    }
    console.error('Failed to load public community profile', error)
    return res.status(500).json({ error: 'Unable to load profile' })
  }
})

export default router
