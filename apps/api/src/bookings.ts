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
  sessions: z.number().int().min(1).max(30), // juster max hvis du vil
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
 * So last session start must be <= 14:40 (if 1 session)
 * For multiple sessions: last start <= 14:40 - (sessions-1)*20
 */
function validateWithinBusinessHours(start: DateTime, sessions: number) {
  const dayStart = start.set(DAY_START);
  const dayEnd = start.set(DAY_END);

  if (start < dayStart) {
    return { ok: false, message: "Start time is before opening hours (08:00)." };
  }

  // Last session start time:
  const lastStart = start.plus({ minutes: (sessions - 1) * STEP_MIN });
  // Last session end time:
  const lastEnd = lastStart.plus({ minutes: SESSION_MIN });

  if (lastEnd > dayEnd) {
    return {
      ok: false,
      message:
        "Selected sessions exceed opening hours (must end by 15:00 Oslo time).",
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
  const dayStart = startOslo.set(DAY_START);
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

  // Enforce 15 min sessions (since your business rule is fixed)
  // If you want it flexible per service, remove this check.
  if (service.durationMin !== SESSION_MIN) {
    return res.status(400).json({
      message: `Service duration must be ${SESSION_MIN} minutes for this booking flow`,
    });
  }

  // 5) Build all session starts in UTC for DB
  const startsUtc = buildSessionStartsUtc(startOslo, sessions);

  // 6) Transaction: check conflicts + create bookings
  try {
    const created = await prisma.$transaction(async (tx) => {
      // Check if any of the starts are already booked (status != CANCELLED)
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

      // Create one Booking per session (recommended)
      const rows = startsUtc.map((startAt) => ({
        userId,
        serviceId,
        startAt,
        endAt: new Date(startAt.getTime() + SESSION_MIN * 60 * 1000),
        status: "CONFIRMED" as const,
        note: note ?? null,
      }));

      const result = await tx.booking.createMany({
        data: rows,
      });

      // Return the created slots (fetch them back with IDs)
      // createMany doesn't return rows, so we fetch by userId/serviceId/time range.
      const createdBookings = await tx.booking.findMany({
        where: {
          userId,
          serviceId,
          startAt: { in: startsUtc },
        },
        orderBy: { startAt: "asc" },
        select: {
          id: true,
          startAt: true,
          endAt: true,
          status: true,
        },
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
