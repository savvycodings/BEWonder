import crypto from 'crypto'
import express from 'express'
import { v2 as cloudinary } from 'cloudinary'
import { runQuery } from '../db/client'
import {
  createSessionForUser,
  getAuthUserFromRequest,
  revokeSessionByToken,
} from './session'

const router = express.Router()
const DAILY_REWARD_AMOUNTS = [1, 2, 3, 4, 5, 6, 7]
const DAILY_REWARD_INTERVAL_MS = 24 * 60 * 60 * 1000

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
})

const ALLOWED_AVATAR_FRAMES = new Set(['none', 'neon', 'gold', 'rainbow', 'prism'])

function normalizeStoredAvatarFrame(raw: string | null | undefined): string {
  const v = String(raw ?? 'none').trim()
  return ALLOWED_AVATAR_FRAMES.has(v) ? v : 'none'
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
  wallet_balance: number
}

async function ensureDailyRewardRow(userId: string) {
  await runQuery(
    `
      INSERT INTO user_daily_rewards (user_id, claimed_count, wallet_balance)
      VALUES ($1, 0, 0)
      ON CONFLICT (user_id) DO NOTHING
    `,
    [userId]
  )

  const rowResult = await runQuery<DailyRewardRow>(
    `
      SELECT claimed_count, last_claimed_at, wallet_balance
      FROM user_daily_rewards
      WHERE user_id = $1
      LIMIT 1
    `,
    [userId]
  )

  return rowResult.rows[0]
}

function getDailyRewardPayload(row: DailyRewardRow) {
  const nowMs = Date.now()
  const maxDays = DAILY_REWARD_AMOUNTS.length
  const claimedCount = Math.max(0, Math.min(row.claimed_count, maxDays))
  const lastClaimMs = new Date(row.last_claimed_at).getTime()
  const nextUnlockMs = lastClaimMs + DAILY_REWARD_INTERVAL_MS
  const hasCompletedAllRewards = claimedCount >= maxDays
  const canClaim = !hasCompletedAllRewards && (claimedCount === 0 || nowMs >= nextUnlockMs)
  const nextUnlockAt =
    hasCompletedAllRewards || claimedCount === 0 ? null : new Date(nextUnlockMs).toISOString()

  return {
    walletBalance: row.wallet_balance,
    claimedCount,
    currentStreakDays: claimedCount,
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

  try {
    const row = await ensureDailyRewardRow(auth.userId)
    if (!row) {
      return res.status(500).json({ error: 'Unable to load daily rewards' })
    }

    return res.status(200).json(getDailyRewardPayload(row))
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

  try {
    await ensureDailyRewardRow(auth.userId)
    const maxDays = DAILY_REWARD_AMOUNTS.length
    const updateResult = await runQuery<DailyRewardRow>(
      `
        UPDATE user_daily_rewards
        SET
          claimed_count = LEAST(claimed_count + 1, $2),
          wallet_balance = wallet_balance + LEAST(claimed_count + 1, $2),
          last_claimed_at = NOW(),
          updated_at = NOW()
        WHERE user_id = $1
          AND claimed_count < $2
          AND (claimed_count = 0 OR last_claimed_at <= NOW() - INTERVAL '24 hours')
        RETURNING claimed_count, last_claimed_at, wallet_balance
      `,
      [auth.userId, maxDays]
    )

    const updatedRow = updateResult.rows[0]
    if (!updatedRow) {
      const currentRow = await ensureDailyRewardRow(auth.userId)
      if (!currentRow) {
        return res.status(500).json({ error: 'Unable to load claim status' })
      }
      return res.status(409).json({
        error: 'Reward is not unlocked yet',
        ...getDailyRewardPayload(currentRow),
      })
    }

    return res.status(200).json(getDailyRewardPayload(updatedRow))
  } catch (error) {
    console.error('Failed to claim daily reward', error)
    return res.status(500).json({ error: 'Unable to claim daily reward' })
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
  } catch (error) {
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

export default router
