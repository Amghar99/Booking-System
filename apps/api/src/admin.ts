import { Router } from "express";
import { z } from "zod";
import { prisma } from "./prisma.js";
import { requireAuth, requireRole } from "./middleware.js";

const router = Router();

// --- PING (eksisterende) ---
router.get("/ping", requireAuth, requireRole("ADMIN"), (_req, res) => {
  res.json({ ok: true, message: "admin access ok" });
});

// --- CREATE SERVICE ---
const createServiceSchema = z.object({
  name: z.string().min(1),
  description: z.string().max(500).optional(),
  durationMin: z.number().int().positive().default(60),
  isActive: z.boolean().default(true),
});

router.post("/services", requireAuth, requireRole("ADMIN"), async (req, res) => {
  const parsed = createServiceSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ errors: parsed.error.flatten() });

  const { name, description, durationMin, isActive } = parsed.data;

  const service = await prisma.service.create({
    data: { name, description, durationMin, isActive },
  });

  res.status(201).json(service);
});

// --- CREATE AVAILABILITY SLOT ---
const createSlotSchema = z.object({
  serviceId: z.string().min(1),
  startAt: z.string().datetime(),
  endAt: z.string().datetime(),
});

router.post("/slots", requireAuth, requireRole("ADMIN"), async (req, res) => {
  const parsed = createSlotSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ errors: parsed.error.flatten() });

  const { serviceId, startAt, endAt } = parsed.data;
  const startDate = new Date(startAt);
  const endDate = new Date(endAt);

  if (!(startDate < endDate)) return res.status(400).json({ message: "startAt must be before endAt" });

  const service = await prisma.service.findUnique({ where: { id: serviceId } });
  if (!service) return res.status(404).json({ message: "Service not found" });

  const slot = await prisma.availabilitySlot.create({
    data: {
      serviceId,
      startAt: startDate,
      endAt: endDate,
    },
  });

  res.status(201).json(slot);
});

// --- GET ALL SERVICES ---
router.get("/services", requireAuth, requireRole("ADMIN"), async (_req, res) => {
  const services = await prisma.service.findMany({
    orderBy: { createdAt: "desc" },
    include: { slots: true, bookings: true },
  });
  res.json(services);
});

// --- GET ALL SLOTS FOR A SERVICE ---
router.get("/slots/:serviceId", requireAuth, requireRole("ADMIN"), async (req, res) => {
  const { serviceId } = req.params;
  const slots = await prisma.availabilitySlot.findMany({
    where: { serviceId },
    orderBy: { startAt: "asc" },
  });
  res.json(slots);
});

export default router;
