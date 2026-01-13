import { Router } from "express";
import { z } from "zod";
import { DateTime } from "luxon";
import { prisma } from "./prisma.js";
import { requireAuth } from "./middleware.js";

const router = Router();

/**
 * Booking-regler
 */
const OSLO_TZ = "Europe/Oslo";
const DAY_START = { hour: 8, minute: 0 };
const DAY_END = { hour: 15, minute: 0 }; // siste sluttpunkt, ikke siste start
const SESSION_MIN = 15;
const BUFFER_MIN = 5;
const STEP_MIN = SESSION_MIN + BUFFER_MIN; // 20 min mellom starter

/**
 * Input schema for POST /bookings
 * date: YYYY-MM-DD
 * startTime: HH:mm (24h)
 */
const createBookingSchema = z.object({
  serviceId: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD"),
  startTime: z.string().regex(/^\d{2}:\d{2}$/, "startTime must be HH:mm"),
  sessions: z.number().int().min(1).max(30),
  note: z.string().max(500).optional(),
});

/**
 * Parse "YYYY-MM-DD" + "HH:mm" as a Luxon DateTime in Europe/Oslo
 */
function parseOsloDateTime(date: string, time: string): DateTime {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);

  return DateTime.fromObject(
    { year: y, month: m, day: d, hour: hh, minute: mm },
    { zone: OSLO_TZ }
  );
}

/**
 * Checks if the start time aligns with our 20-min step from 08:00 (08:00, 08:20, 08:40, ...)
 */
function isAlignedToStep(dt: DateTime): boolean {
  const dayStart = dt.set(DAY_START);
  const diffMin = Math.round(dt.diff(dayStart, "minutes").minutes);
  return diffMin >= 0 && diffMin % STEP_MIN === 0;
}

/**
 * Ensure all sessions fit inside opening hours (Oslo time).
 * Each session is 15 min, next starts after 20 min.
 */
function validateWithinBusinessHours(start: DateTime, sessions: number) {
  const dayStart = start.set(DAY_START);
  const dayEnd = start.set(DAY_END);

  if (start < dayStart) {
    return { ok: false, message: "Start time is before opening hours (08:00)." };
  }

  const lastStart = start.plus({ minutes: (sessions - 1) * STEP_MIN });
  const lastEnd = lastStart.plus({ minutes: SESSION_MIN });

  if (lastEnd > dayEnd) {
    return {
      ok: false,
      message: "Selected sessions exceed opening hours (must end by 15:00 Oslo time).",
    };
  }

  return { ok: true as const };
}

/**
 * Build the list of session start times (UTC JS Dates) for DB
 */
function buildSessionStartsUtc(startOslo: DateTime, sessions: number): Date[] {
  const starts: Date[] = [];
  for (let i = 0; i < sessions; i++) {
    const s = startOslo.plus({ minutes: i * STEP_MIN }).toUTC();
    starts.push(s.toJSDate());
  }
  return starts;
}

/**
 * Returns true if [startAt, endAt] is fully contained inside at least one slot.
 */
function isSessionCoveredBySlots(
  startAt: Date,
  endAt: Date,
  slots: { startAt: Date; endAt: Date }[]
) {
  return slots.some((s) => s.startAt <= startAt && s.endAt >= endAt);
}

/**
 * GET /bookings/availability?serviceId=...&date=YYYY-MM-DD
 * Returns available start times (HH:mm, Oslo time) based on:
 * - Admin AvailabilitySlot windows (DB UTC)
 * - Already booked slots (status != CANCELLED)
 * - 20-min grid from 08:00
 */
router.get("/availability", async (req, res) => {
  const serviceId = String(req.query.serviceId ?? "");
  const date = String(req.query.date ?? "");

  if (!serviceId) return res.status(400).json({ message: "serviceId is required" });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ message: "date must be YYYY-MM-DD" });
  }

  // 1) service exists + active
  const service = await prisma.service.findUnique({
    where: { id: serviceId },
    select: { id: true, isActive: true, durationMin: true },
  });

  if (!service || !service.isActive) {
    return res.status(404).json({ message: "Service not found or inactive" });
  }

  // Keep same fixed rule as POST /bookings
  if (service.durationMin !== SESSION_MIN) {
    return res.status(400).json({ message: `Service duration must be ${SESSION_MIN} minutes` });
  }

  // 2) Build Oslo day start/end and convert to UTC for DB queries
  const [y, m, d] = date.split("-").map(Number);
  const dayStartOslo = DateTime.fromObject(
    { year: y, month: m, day: d, ...DAY_START },
    { zone: OSLO_TZ }
  );
  const dayEndOslo = DateTime.fromObject(
    { year: y, month: m, day: d, ...DAY_END },
    { zone: OSLO_TZ }
  );

  const dayStartUtc = dayStartOslo.toUTC().toJSDate();
  const dayEndUtc = dayEndOslo.toUTC().toJSDate();

  // 3) Fetch admin slots overlapping this day
  const slots = await prisma.availabilitySlot.findMany({
    where: {
      serviceId,
      startAt: { lt: dayEndUtc },
      endAt: { gt: dayStartUtc },
    },
    orderBy: { startAt: "asc" },
    select: { startAt: true, endAt: true },
  });

  // 4) Fetch already booked session starts this day
  const booked = await prisma.booking.findMany({
    where: {
      serviceId,
      status: { not: "CANCELLED" },
      startAt: { gte: dayStartUtc, lt: dayEndUtc },
    },
    select: { startAt: true },
  });

  const bookedSet = new Set(booked.map((b) => b.startAt.toISOString()));

  // 5) Generate candidate times on 20-min grid and filter by slot coverage + not booked
  const times: string[] = [];

  for (let t = dayStartOslo; t < dayEndOslo; t = t.plus({ minutes: STEP_MIN })) {
    const startUtc = t.toUTC().toJSDate();
    const endUtc = new Date(startUtc.getTime() + SESSION_MIN * 60 * 1000);

    const covered = slots.some((s) => s.startAt <= startUtc && s.endAt >= endUtc);
    if (!covered) continue;

    if (bookedSet.has(startUtc.toISOString())) continue;

    // Return Oslo time for UI
    times.push(t.toFormat("HH:mm"));
  }

  return res.json({ serviceId, date, times });
});

/**
 * POST /bookings
 * Body: { serviceId, date, startTime, sessions, note? }
 */
router.post("/", requireAuth, async (req, res) => {
  const parsed = createBookingSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ errors: parsed.error.flatten() });
  }

  const { serviceId, date, startTime, sessions, note } = parsed.data;
  const userId = (req as any).user?.userId as string | undefined;

  if (!userId) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  // 1) Parse start time in Oslo timezone
  const startOslo = parseOsloDateTime(date, startTime);
  if (!startOslo.isValid) {
    return res.status(400).json({ message: "Invalid date/startTime" });
  }

  // 2) Enforce alignment to 20-min grid
  if (!isAlignedToStep(startOslo)) {
    return res.status(400).json({
      message: `startTime must be aligned to ${STEP_MIN}-minute slots from 08:00 (e.g. 08:00, 08:20, 08:40 ...)`,
    });
  }

  // 3) Enforce opening hours
  const hoursCheck = validateWithinBusinessHours(startOslo, sessions);
  if (!hoursCheck.ok) {
    return res.status(400).json({ message: hoursCheck.message });
  }

  // (Valgfritt) Ikke tillat booking i fortid
  if (startOslo < DateTime.now().setZone(OSLO_TZ)) {
    return res.status(400).json({ message: "Cannot book a time in the past" });
  }

  // 4) Ensure service exists and is active
  const service = await prisma.service.findUnique({
    where: { id: serviceId },
    select: { id: true, isActive: true, durationMin: true },
  });

  if (!service || !service.isActive) {
    return res.status(404).json({ message: "Service not found or inactive" });
  }

  // Enforce 15 min sessions (fixed rule for this booking flow)
  if (service.durationMin !== SESSION_MIN) {
    return res.status(400).json({
      message: `Service duration must be ${SESSION_MIN} minutes for this booking flow`,
    });
  }

  // 5) Build all session starts in UTC for DB
  const startsUtc = buildSessionStartsUtc(startOslo, sessions);

  // 5.1) Enforce admin availability slots for this service (UTC in DB)
  const firstStartUtc = startsUtc[0];
  const lastStartUtc = startsUtc[startsUtc.length - 1];
  const lastEndUtc = new Date(lastStartUtc.getTime() + SESSION_MIN * 60 * 1000);

  const candidateSlots = await prisma.availabilitySlot.findMany({
    where: {
      serviceId,
      startAt: { lt: lastEndUtc },
      endAt: { gt: firstStartUtc },
    },
    orderBy: { startAt: "asc" },
    select: { startAt: true, endAt: true },
  });

  for (const startAt of startsUtc) {
    const endAt = new Date(startAt.getTime() + SESSION_MIN * 60 * 1000);
    if (!isSessionCoveredBySlots(startAt, endAt, candidateSlots)) {
      return res.status(400).json({
        message: "Selected time is not within admin availability for this service",
      });
    }
  }

  // 6) Transaction: check conflicts + create bookings
  try {
    const created = await prisma.$transaction(async (tx) => {
      const conflicts = await tx.booking.findMany({
        where: {
          serviceId,
          status: { not: "CANCELLED" },
          startAt: { in: startsUtc },
        },
        select: { id: true, startAt: true },
      });

      if (conflicts.length > 0) {
        return { ok: false as const, conflicts };
      }

      const rows = startsUtc.map((startAt) => ({
        userId,
        serviceId,
        startAt,
        endAt: new Date(startAt.getTime() + SESSION_MIN * 60 * 1000),
        status: "CONFIRMED" as const,
        note: note ?? null,
      }));

      const result = await tx.booking.createMany({ data: rows });

      const createdBookings = await tx.booking.findMany({
        where: { userId, serviceId, startAt: { in: startsUtc } },
        orderBy: { startAt: "asc" },
        select: { id: true, startAt: true, endAt: true, status: true },
      });

      return { ok: true as const, count: result.count, bookings: createdBookings };
    });

    if (!created.ok) {
      return res.status(409).json({
        message: "One or more selected slots are already booked",
        conflicts: created.conflicts,
      });
    }

    return res.status(201).json({
      message: "Booked",
      count: created.count,
      bookings: created.bookings,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Server error" });
  }
});

export default router;
