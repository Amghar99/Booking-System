import { Router } from "express";
import { z } from "zod";
import { prisma } from "./prisma.js";
import { requireAuth, requireRole } from "./middleware.js";

const router = Router();

const createServiceSchema = z.object({
  name: z.string().min(2),
  description: z.string().optional(),
  durationMin: z.number().int().min(5).max(8 * 60).optional(),
});

const createSlotSchema = z.object({
  startAt: z.string().datetime(),
  endAt: z.string().datetime(),
});

router.get("/", async (_req, res) => {
  const services = await prisma.service.findMany({
    where: { isActive: true },
    orderBy: { createdAt: "desc" },
  });
  res.json(services);
});

router.post("/", requireAuth, requireRole("ADMIN"), async (req, res) => {
  const parsed = createServiceSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ errors: parsed.error.flatten() });

  const service = await prisma.service.create({ data: parsed.data });
  res.status(201).json(service);
});

// Legg til availability-slot for en service (ADMIN)
router.post("/:serviceId/availability", requireAuth, requireRole("ADMIN"), async (req, res) => {
  const { serviceId } = req.params;

  const parsed = createSlotSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ errors: parsed.error.flatten() });

  const startAt = new Date(parsed.data.startAt);
  const endAt = new Date(parsed.data.endAt);

  if (!(startAt < endAt)) return res.status(400).json({ message: "startAt must be before endAt" });

  const service = await prisma.service.findUnique({ where: { id: serviceId } });
  if (!service) return res.status(404).json({ message: "Service not found" });

  const slot = await prisma.availabilitySlot.create({
    data: { serviceId, startAt, endAt },
  });

  res.status(201).json(slot);
});

// Hent availability for en service (public)
router.get("/:serviceId/availability", async (req, res) => {
  const { serviceId } = req.params;

  const slots = await prisma.availabilitySlot.findMany({
    where: { serviceId },
    orderBy: { startAt: "asc" },
  });

  res.json(slots);
});

export default router;
