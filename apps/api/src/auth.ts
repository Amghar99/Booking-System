import { Router } from "express";
import { z } from "zod";
import bcrypt from "bcryptjs";
import jwt, { type SignOptions } from "jsonwebtoken";
import { prisma } from "./prisma.js";
import { requireAuth } from "./middleware.js";

const router = Router();

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

function setAccessCookie(res: any, token: string) {
  res.cookie("access_token", token, {
    httpOnly: true,
    sameSite: "lax",
    secure: false, // sett true i prod (HTTPS)
    path: "/",
  });
}

router.post("/register", async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ errors: parsed.error.flatten() });
  }

  const { email, password } = parsed.data;
  const passwordHash = await bcrypt.hash(password, 12);

  try {
    const user = await prisma.user.create({
      data: { email, passwordHash, role: "USER" },
      select: { id: true, email: true, role: true, createdAt: true },
    });

    return res.status(201).json(user);
  } catch (e: any) {
    // Prisma unique constraint violation
    if (e?.code === "P2002") {
      return res.status(409).json({ message: "Email already in use" });
    }
    return res.status(500).json({ message: "Server error" });
  }
});

router.post("/login", async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ errors: parsed.error.flatten() });
  }

  const { email, password } = parsed.data;

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return res.status(401).json({ message: "Invalid credentials" });

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(401).json({ message: "Invalid credentials" });

  const secret = process.env.JWT_ACCESS_SECRET;
  if (!secret) {
    return res.status(500).json({ message: "JWT_ACCESS_SECRET is missing" });
  }

  const expiresIn: SignOptions["expiresIn"] =
    (process.env.JWT_ACCESS_EXPIRES_IN ?? "15m") as SignOptions["expiresIn"];

  const token = jwt.sign(
    { userId: user.id, role: user.role },
    secret,
    { expiresIn }
  );

  setAccessCookie(res, token);

  return res.json({ id: user.id, email: user.email, role: user.role });
});

router.post("/logout", async (_req, res) => {
  res.clearCookie("access_token", { path: "/" });
  return res.json({ message: "Logged out" });
});

router.get("/me", requireAuth, async (req, res) => {
  const { userId } = (req as any).user as { userId: string };

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, role: true, createdAt: true },
  });

  return res.json(user);
});

export default router;
