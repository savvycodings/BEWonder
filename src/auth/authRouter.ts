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
  getWonderJumpLeaderboardRankForUser,
  getWonderJumpProgressForUser,
  mergeWonderJumpProgressForUser,
  pickupWonderJumpChestForUser,
  startWonderJumpChestTimerForUser,
} from './wonderJumpProgress'
import { ALLOWED_AVATAR_FRAMES, normalizeStoredAvatarFrameId } from '../constants/avatarFrames'
import { validateProfileDisplayName } from '../constants/profileDisplayName'
import { normalizeLegacyWonderBadgeId, WONDER_PROFILE_BADGE_IDS } from '../constants/wonderBadges'
import { runLoginStreakBump, runLoginStreakReconcile } from './dailyRewardsStreak'
import {
  DAILY_REWARD_AMOUNTS,
  DAILY_REWARD_CYCLE_LENGTH,
  buildDailyRewardItems,
  cyclePositionForNextClaim,
  rewardWindowStartDay as computeRewardWindowStartDay,
} from './dailyRewardsCycle'
import {
  fetchLocalDailyRewardSchedule,
  getClientTimeZoneFromRequest,
} from './dailyRewardsLocalSchedule'
import { hashPassword, verifyPassword } from './passwordCrypto'
import {
  getPasswordHashForUser,
  requestPasswordResetOtp,
  resetPasswordWithOtp,
  updatePasswordHashForUser,
  validateNewPasswordPair,
  verifyPasswordResetOtp,
} from './passwordReset'
import {
  consumeSignupEmailVerification,
  requestEmailOtp,
  verifyEmailOtp,
  type EmailOtpPurpose,
} from './emailOtp'
import { registerUserSavedProductRoutes } from './userSavedProductsRoutes'
import { registerUserCartRoutes } from './userCartRoutes'

const router = express.Router()
registerUserSavedProductRoutes(router)
registerUserCartRoutes(router)

/** Wonder Store item ids → cost in wonder coins (server is source of truth). */
const WONDER_STORE_ITEM_COSTS: Record<string, number> = {
  midnight: 5,
  sunset: 5,
  mint: 5,
  royal: 5,
  peach: 5,
  forest: 5,
  avatar_frame_neon: 5,
  avatar_frame_gold: 5,
  avatar_frame_rainbow: 5,
  avatar_frame_prism: 7,
  avatar_frame_meridian: 7,
  avatar_frame_hex: 12,
  avatar_frame_shard: 12,
  avatar_frame_rune: 12,
  avatar_frame_sentinel: 12,
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

const ADDRESS_TEXT_PATTERN = /^[a-zA-Z0-9\s,.'#/-]+$/
const PLACE_NAME_PATTERN = /^[a-zA-Z][a-zA-Z\s'.-]*$/

function validateShippingAddressFields(fields: {
  shippingAddress?: string
  shippingAddressLine2?: string
  shippingPostalCode?: string
  shippingCity?: string
  shippingProvince?: string
}) {
  if (fields.shippingAddress !== undefined) {
    if (!fields.shippingAddress || fields.shippingAddress.length < 5 || !ADDRESS_TEXT_PATTERN.test(fields.shippingAddress)) {
      return 'Enter a valid street address.'
    }
  }

  if (fields.shippingAddressLine2 && !ADDRESS_TEXT_PATTERN.test(fields.shippingAddressLine2)) {
    return 'Enter a valid apartment, suite, or unit.'
  }

  if (fields.shippingPostalCode !== undefined && !/^\d{4}$/.test(fields.shippingPostalCode)) {
    return 'Enter a valid 4-digit postal code.'
  }

  if (fields.shippingCity !== undefined) {
    if (!fields.shippingCity || !PLACE_NAME_PATTERN.test(fields.shippingCity)) {
      return 'Enter a valid city name.'
    }
  }

  if (fields.shippingProvince !== undefined) {
    if (!fields.shippingProvince || !PLACE_NAME_PATTERN.test(fields.shippingProvince)) {
      return 'Enter a valid province.'
    }
  }

  return null
}

type DailyRewardRow = {
  claimed_count: number
  last_claimed_at: string | null
  login_streak_count: number
  login_streak_last_calendar_date: string | null
}

async function ensureDailyRewardRowTx(client: PoolClient, userId: string) {
  await client.query(
    `
      INSERT INTO user_daily_rewards (user_id, claimed_count, wallet_balance, last_claimed_at)
      VALUES ($1, 0, 0, NULL)
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
  const maxDays = DAILY_REWARD_CYCLE_LENGTH
  const claimedCount = Math.max(0, Math.min(row.claimed_count, maxDays))
  const [wonderCoins, wonderGems, ownedStoreItemIds, paidOrderCount, wonderJumpRank, schedule] = await Promise.all([
    getUserWonderCoins(userId),
    getUserWonderGems(userId),
    getOwnedWonderStoreItemIds(userId),
    getPaidOrderCount(userId),
    getWonderJumpLeaderboardRankForUser(userId),
    fetchLocalDailyRewardSchedule(pool, userId, timeZone, claimedCount, maxDays),
  ])
  return getDailyRewardPayload(row, wonderCoins, wonderGems, ownedStoreItemIds, paidOrderCount, wonderJumpRank, schedule)
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

async function getUserWonderGems(userId: string): Promise<number> {
  const r = await runQuery<{ wonder_gems: number }>(
    `
      SELECT wonder_gems
      FROM users
      WHERE id::text = $1
      LIMIT 1
    `,
    [userId]
  )
  const v = r.rows[0]?.wonder_gems
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
  wonderGems: number,
  ownedStoreItemIds: string[],
  paidOrderCount: number,
  wonderJumpRank: number | null,
  schedule: { canClaimByLocalCalendar: boolean; nextUnlockAt: string | null },
) {
  const maxDays = DAILY_REWARD_CYCLE_LENGTH
  const claimedCount = Math.max(0, Math.min(row.claimed_count, maxDays))
  const canClaim = schedule.canClaimByLocalCalendar
  const nextUnlockAt = claimedCount === 0 && canClaim ? null : schedule.nextUnlockAt

  const loginStreak =
    typeof row.login_streak_count === 'number' && Number.isFinite(row.login_streak_count)
      ? Math.max(0, Math.floor(row.login_streak_count))
      : 0

  const windowStartDay = computeRewardWindowStartDay(loginStreak)

  return {
    walletBalance: wonderCoins,
    gemBalance: wonderGems,
    ownedStoreItemIds,
    /** Claims completed in the current 7-day reward window (resets after each day-7 claim). */
    claimedCount,
    /** Consecutive local-calendar-day login streak (keeps counting past day 7 for badges). */
    currentStreakDays: loginStreak,
    rewardWindowStartDay: windowStartDay,
    paidOrderCount,
    wonderJumpRank,
    canClaim,
    nextUnlockAt,
    rewards: buildDailyRewardItems(loginStreak, claimedCount, canClaim),
  }
}

async function userEarnsProfileBadge(userId: string, badgeId: string): Promise<boolean> {
  if (badgeId === 'badge:heart') return true
  const row = await ensureDailyRewardRow(userId)
  if (!row) return false
  const [paid, rank] = await Promise.all([getPaidOrderCount(userId), getWonderJumpLeaderboardRankForUser(userId)])
  const streak =
    typeof row.login_streak_count === 'number' && Number.isFinite(row.login_streak_count)
      ? Math.max(0, Math.floor(row.login_streak_count))
      : 0
  const claimed = Math.max(0, Math.floor(row.claimed_count))

  switch (badgeId) {
    case 'badge:day7':
      return streak >= 7 || claimed >= 7
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
    case 'badge:wj_top100':
      return rank !== null && rank <= 100
    case 'badge:wj_top50':
      return rank !== null && rank <= 50
    case 'badge:wj_top10':
      return rank !== null && rank <= 10
    case 'badge:wj_top3':
      return rank !== null && rank <= 3
    case 'badge:wj_top2':
      return rank !== null && rank <= 2
    case 'badge:wj_top1':
      return rank !== null && rank <= 1
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
  const shippingPostalCode = String(req.body?.shippingPostalCode || '').trim()
  const shippingCity = String(req.body?.shippingCity || '').trim()
  const shippingProvince = String(req.body?.shippingProvince || '').trim()
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

  const fullNameError = validateProfileDisplayName(fullName)
  if (fullNameError) {
    return res.status(400).json({ error: fullNameError })
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

  if (process.env.AUTH_REQUIRE_SIGNUP_EMAIL_VERIFY === 'true') {
    const verified = await consumeSignupEmailVerification(email)
    if (!verified) {
      return res.status(400).json({
        error: 'Verify your email with the 6-digit code before creating an account.',
      })
    }
  }

  if (password.length < 8) {
    return res.status(400).json({
      error: 'Password must be at least 8 characters',
    })
  }

  const shippingError = validateShippingAddressFields({
    shippingAddress: shippingAddress || undefined,
    shippingAddressLine2: shippingAddressLine2 || undefined,
    shippingPostalCode: shippingPostalCode || undefined,
    shippingCity: shippingCity || undefined,
    shippingProvince: shippingProvince || undefined,
  })
  if (shippingError) {
    return res.status(400).json({ error: shippingError })
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
      shipping_postal_code: string | null
      shipping_city: string | null
      shipping_region: string | null
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
          shipping_postal_code,
          shipping_city,
          shipping_region,
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
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8,
          $9, $10, $11, $12, $13, $14, $15, $16,
          NOW(), NOW()
        )
        RETURNING
          id,
          email,
          created_at,
          name,
          image,
          shipping_address1,
          shipping_address2,
          shipping_postal_code,
          shipping_city,
          shipping_region,
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
        shippingPostalCode || null,
        shippingCity || null,
        shippingProvince || null,
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
        shippingPostalCode: user.shipping_postal_code,
        shippingCity: user.shipping_city,
        shippingProvince: user.shipping_region,
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

function parseEmailOtpPurpose(raw: unknown): EmailOtpPurpose | null {
  const p = String(raw || '').trim().toLowerCase()
  if (p === 'signin') return 'signin'
  if (p === 'signup' || p === 'register') return 'signup'
  return null
}

/** Email one-time code for sign-in or sign-up email verification (Resend). */
router.post('/email-code/request', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase()
  const purpose = parseEmailOtpPurpose(req.body?.purpose)
  if (!email || !isValidEmail(email)) {
    return res.status(400).json({ error: 'A valid email address is required' })
  }
  if (!purpose) {
    return res.status(400).json({ error: 'purpose must be signin or signup' })
  }

  try {
    console.log('[auth/email-code/request]', { email, purpose })
    const result = await requestEmailOtp(email, purpose)
    const body: Record<string, unknown> = {
      ok: true,
      message: 'If this step applies to your email, a verification code was sent.',
    }
    if (result.devOtpLogged && process.env.NODE_ENV !== 'production') {
      body.devHint = 'Code logged on the API server console (AUTH_EMAIL_LOG_OTP).'
    }
    if (result.emailWarning) {
      body.emailWarning = result.emailWarning
    }
    body.emailSent = result.emailSent === true
    return res.status(200).json(body)
  } catch (error: any) {
    if (error?.status === 503 || error?.code === '42P01') {
      return res.status(503).json({
        error: 'Email codes are not available yet',
        detail: 'Run db:migrate so verifications exists.',
      })
    }
    console.error('Failed to request email code', error)
    return res.status(500).json({ error: 'Unable to send verification code' })
  }
})

router.post('/email-code/verify', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase()
  const otp = String(req.body?.otp || req.body?.code || '').trim()
  const purpose = parseEmailOtpPurpose(req.body?.purpose)
  if (!email || !otp) {
    return res.status(400).json({ error: 'Email and verification code are required' })
  }
  if (!purpose) {
    return res.status(400).json({ error: 'purpose must be signin or signup' })
  }

  try {
    const valid = await verifyEmailOtp(email, otp, purpose)
    if (!valid) {
      return res.status(400).json({ error: 'Invalid or expired verification code' })
    }

    if (purpose === 'signup') {
      return res.status(200).json({
        ok: true,
        emailVerified: true,
        message: 'Email verified. You can finish creating your account.',
      })
    }

    const accountResult = await runQuery<{ user_id: string }>(
      `
        SELECT user_id
        FROM accounts
        WHERE provider_id = 'password'
          AND provider_user_id = $1
        LIMIT 1
      `,
      [email],
    )
    const account = accountResult.rows[0]
    if (!account) {
      return res.status(401).json({ error: 'No account found for this email' })
    }

    const userResult = await runQuery<{
      id: string
      email: string
      created_at: string
      name: string | null
      image: string | null
      shipping_address1: string | null
      shipping_address2: string | null
      shipping_postal_code: string | null
      shipping_city: string | null
      shipping_region: string | null
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
          shipping_postal_code,
          shipping_city,
          shipping_region,
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
      [account.user_id],
    )

    const user = userResult.rows[0]
    if (!user) {
      return res.status(401).json({ error: 'No account found for this email' })
    }

    const sessionToken = await createSessionForUser(user.id)
    try {
      await ensureDailyRewardRow(user.id)
    } catch (e) {
      console.warn('[auth/email-code] daily rewards row skipped', e)
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
        shippingPostalCode: user.shipping_postal_code,
        shippingCity: user.shipping_city,
        shippingProvince: user.shipping_region,
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
    if (error?.code === '42P01') {
      return res.status(503).json({ error: 'Email codes are not available yet' })
    }
    console.error('Failed to verify email code', error)
    return res.status(500).json({ error: 'Unable to verify code' })
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
      shipping_postal_code: string | null
      shipping_city: string | null
      shipping_region: string | null
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
          shipping_postal_code,
          shipping_city,
          shipping_region,
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
        shippingPostalCode: user.shipping_postal_code,
        shippingCity: user.shipping_city,
        shippingProvince: user.shipping_region,
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
    const maxDays = DAILY_REWARD_CYCLE_LENGTH
    if (row.claimed_count >= maxDays) {
      await runQuery(
        `
          UPDATE user_daily_rewards
          SET claimed_count = 0, updated_at = NOW()
          WHERE user_id = $1 AND claimed_count >= $2
        `,
        [auth.userId, maxDays],
      )
      row = { ...row, claimed_count: 0 }
    }
    try {
      await runLoginStreakReconcile(pool, auth.userId, tz)
    } catch (e: any) {
      if (e?.code !== '42703') throw e
    }
    row = (await ensureDailyRewardRow(auth.userId)) ?? row

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
  const maxDays = DAILY_REWARD_CYCLE_LENGTH
  const tz = getClientTimeZoneFromRequest(req)

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    let beforeRow = await ensureDailyRewardRowTx(client, userId)
    if (!beforeRow) {
      await client.query('ROLLBACK')
      return res.status(500).json({ error: 'Unable to load daily rewards' })
    }
    if (beforeRow.claimed_count >= maxDays) {
      await client.query(
        `
          UPDATE user_daily_rewards
          SET claimed_count = 0, updated_at = NOW()
          WHERE user_id = $1 AND claimed_count >= $2
        `,
        [userId, maxDays],
      )
      beforeRow = { ...beforeRow, claimed_count: 0 }
    }

    try {
      await runLoginStreakReconcile(client, userId, tz)
      const refreshed = await ensureDailyRewardRowTx(client, userId)
      if (refreshed) beforeRow = refreshed
    } catch (e: any) {
      if (e?.code !== '42703') throw e
    }

    const cycleDay = cyclePositionForNextClaim(beforeRow.claimed_count)
    const gemsAdded = DAILY_REWARD_AMOUNTS[cycleDay - 1] ?? cycleDay

    const updateResult = await client.query<DailyRewardRow>(
      `
        UPDATE user_daily_rewards
        SET
          claimed_count = CASE
            WHEN claimed_count + 1 >= $2 THEN 0
            ELSE claimed_count + 1
          END,
          last_claimed_at = NOW(),
          updated_at = NOW()
        WHERE user_id = $1
          AND (
            last_claimed_at IS NULL
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

    await client.query(
      `
        UPDATE users
        SET wonder_gems = wonder_gems + $2, updated_at = NOW()
        WHERE id::text = $1
      `,
      [userId, gemsAdded]
    )

    try {
      // Bump only — do not reconcile here (reconcile on GET). Reconcile before bump on claim
      // could zero the streak then restart at 1 while claimed_count keeps growing.
      await runLoginStreakBump(client, userId, false, tz)
      await client.query(
        `
          UPDATE user_daily_rewards
          SET login_streak_count = GREATEST(login_streak_count, LEAST(claimed_count, $2))
          WHERE user_id = $1
            AND claimed_count > 0
            AND claimed_count <= $2
        `,
        [userId, maxDays],
      )
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
  const limit = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 100
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

router.post('/wonder-jump-chest/start', async (_req, res) => {
  const auth = await getAuthUserFromRequest(_req)
  if (!auth) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  try {
    const data = await startWonderJumpChestTimerForUser(auth.userId)
    return res.status(200).json(data)
  } catch (error: any) {
    if (error?.code === '42P01' || error?.code === '42703') {
      return res.status(503).json({
        error: 'WonderJump chest is not available yet',
        detail: 'Run pnpm db:migrate (wonder_jump_chest_unlocks_at column).',
      })
    }
    console.error('Failed to start WonderJump chest timer', error)
    return res.status(500).json({ error: 'Unable to start chest timer' })
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
      wonderGems: result.wonderGems,
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

    const spend = await client.query<{ wonder_gems: number }>(
      `
        UPDATE users
        SET wonder_gems = wonder_gems - $2, updated_at = NOW()
        WHERE id::text = $1
          AND wonder_gems >= $2
        RETURNING wonder_gems
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
        error: 'Not enough gems',
        ...(await buildDailyRewardApiPayload(userId, row, tz)),
      })
    }

    await client.query(
      `
        INSERT INTO user_wonder_store_purchases (user_id, item_id, cost_coins)
        VALUES ($1, $2, GREATEST($3, 1))
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
  const nextShippingAddress = str(b.shippingAddress)
  const nextShippingAddressLine2 = str(b.shippingAddressLine2)
  const nextShippingPostalCode = str(b.shippingPostalCode)
  const nextShippingCity = str(b.shippingCity)
  const nextShippingProvince = str(b.shippingProvince)

  if (nextName !== undefined) {
    const nameError = validateProfileDisplayName(nextName)
    if (nameError) {
      return res.status(400).json({ error: nameError })
    }
  }
  if (nextEmail !== undefined) {
    if (!nextEmail) return res.status(400).json({ error: 'email cannot be empty' })
    if (!isValidEmail(nextEmail)) {
      return res.status(400).json({ error: 'Email address is invalid' })
    }
  }
  const shippingError = validateShippingAddressFields({
    shippingAddress: nextShippingAddress,
    shippingAddressLine2: nextShippingAddressLine2,
    shippingPostalCode: nextShippingPostalCode,
    shippingCity: nextShippingCity,
    shippingProvince: nextShippingProvince,
  })
  if (shippingError) {
    return res.status(400).json({ error: shippingError })
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

  add('shipping_address1', nextShippingAddress)
  add('shipping_address2', nextShippingAddressLine2)
  add('shipping_postal_code', nextShippingPostalCode)
  add('shipping_city', nextShippingCity)
  add('shipping_region', nextShippingProvince)
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
      shipping_postal_code: string | null
      shipping_city: string | null
      shipping_region: string | null
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
          shipping_postal_code,
          shipping_city,
          shipping_region,
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
        shippingPostalCode: user.shipping_postal_code,
        shippingCity: user.shipping_city,
        shippingProvince: user.shipping_region,
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

router.post('/change-password', async (req, res) => {
  const auth = await getAuthUserFromRequest(req)
  if (!auth) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const currentPassword = String(req.body?.currentPassword ?? req.body?.oldPassword ?? '')
  const newPassword = String(req.body?.newPassword ?? '')
  const confirmNewPassword = String(req.body?.confirmNewPassword ?? req.body?.confirmPassword ?? '')

  if (!currentPassword) {
    return res.status(400).json({ error: 'Current password is required' })
  }

  const pairError = validateNewPasswordPair(newPassword, confirmNewPassword)
  if (pairError) {
    return res.status(400).json({ error: pairError })
  }

  if (newPassword === currentPassword) {
    return res.status(400).json({ error: 'New password must be different from your current password' })
  }

  try {
    const storedHash = await getPasswordHashForUser(pool, auth.userId)
    if (!storedHash) {
      return res.status(400).json({
        error: 'This account does not use email/password sign-in.',
      })
    }
    if (!verifyPassword(currentPassword, storedHash)) {
      return res.status(401).json({ error: 'Current password is incorrect' })
    }

    const updated = await updatePasswordHashForUser(pool, auth.userId, hashPassword(newPassword))
    if (!updated) {
      return res.status(500).json({ error: 'Unable to update password' })
    }

    return res.status(200).json({ ok: true, message: 'Password updated.' })
  } catch (error) {
    console.error('Failed to change password', error)
    return res.status(500).json({ error: 'Unable to change password' })
  }
})

/** Forgot-password framework: request a one-time code by email. */
router.post('/forgot-password/request', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase()
  if (!email || !isValidEmail(email)) {
    return res.status(400).json({ error: 'A valid email address is required' })
  }

  try {
    console.log('[auth/forgot-password/request]', { email })
    const result = await requestPasswordResetOtp(email)
    const body: Record<string, unknown> = {
      ok: true,
      message: 'If an account exists for this email, a verification code was sent.',
    }
    if (result.devOtpLogged && process.env.NODE_ENV !== 'production') {
      body.devHint = 'OTP logged on the API server console (PASSWORD_RESET_LOG_OTP).'
    }
    return res.status(200).json(body)
  } catch (error: any) {
    if (error?.status === 503 || error?.code === '42P01') {
      return res.status(503).json({
        error: 'Password reset is not available yet',
        detail: 'Run db:migrate to create password_reset_otps.',
      })
    }
    console.error('Failed to request password reset', error)
    return res.status(500).json({ error: 'Unable to process request' })
  }
})

router.post('/forgot-password/verify', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase()
  const otp = String(req.body?.otp || req.body?.code || '').trim()
  if (!email || !otp) {
    return res.status(400).json({ error: 'Email and verification code are required' })
  }

  try {
    const valid = await verifyPasswordResetOtp(email, otp)
    if (!valid) {
      return res.status(400).json({ error: 'Invalid or expired verification code' })
    }
    return res.status(200).json({ ok: true })
  } catch (error: any) {
    if (error?.code === '42P01') {
      return res.status(503).json({ error: 'Password reset is not available yet' })
    }
    console.error('Failed to verify password reset OTP', error)
    return res.status(500).json({ error: 'Unable to verify code' })
  }
})

router.post('/forgot-password/reset', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase()
  const otp = String(req.body?.otp || req.body?.code || '').trim()
  const newPassword = String(req.body?.newPassword ?? '')
  const confirmNewPassword = String(req.body?.confirmNewPassword ?? req.body?.confirmPassword ?? '')

  if (!email || !otp) {
    return res.status(400).json({ error: 'Email and verification code are required' })
  }

  const pairError = validateNewPasswordPair(newPassword, confirmNewPassword)
  if (pairError) {
    return res.status(400).json({ error: pairError })
  }

  try {
    const result = await resetPasswordWithOtp(email, otp, newPassword)
    if (!result.ok) {
      return res.status(result.status).json({ error: result.message })
    }
    return res.status(200).json({ ok: true, message: 'Password updated. You can sign in with your new password.' })
  } catch (error: any) {
    if (error?.code === '42P01') {
      return res.status(503).json({ error: 'Password reset is not available yet' })
    }
    console.error('Failed to reset password', error)
    return res.status(500).json({ error: 'Unable to reset password' })
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
      avatar_frame: string | null
      image: string | null
    }>(
      `
        SELECT
          profile_banner_url,
          profile_badge_slots,
          COALESCE(
            NULLIF(TRIM(u.avatar_frame), ''),
            NULLIF(TRIM(to_jsonb(u)->>'avatar_frame'), '')
          ) AS avatar_frame,
          COALESCE(
            NULLIF(TRIM(u.profile_picture), ''),
            NULLIF(TRIM(to_jsonb(u)->>'image'), '')
          ) AS image
        FROM users u
        WHERE u.id::text = $1
        LIMIT 1
      `,
      [userId]
    )
    const row = result.rows[0]
    if (!row) return res.status(404).json({ error: 'User not found' })
    return res.status(200).json({
      bannerUrl: normalizeProfileBannerUrl(row.profile_banner_url),
      badgeSlots: normalizeProfileBadgeSlots(row.profile_badge_slots),
      avatarFrameId: normalizeStoredAvatarFrame(row.avatar_frame),
      profilePicture: row.image?.trim() ? row.image : null,
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
