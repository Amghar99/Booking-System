import "dotenv/config";
import prismaPkg from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import bcrypt from "bcryptjs";

const { PrismaClient, Role } = prismaPkg;

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

async function main() {
  // --- ADMIN (Teacher) ---
  const adminPasswordHash = await bcrypt.hash("admin123", 12);

  await prisma.user.upsert({
    where: { email: "admin@test.com" },
    update: {
      passwordHash: adminPasswordHash,
      role: Role.ADMIN,
      firstName: "Teacher",
      lastName: "Admin",
      phone: "99999999",
      // Hvis du har gender/birthYear i schema:
      // gender: "UNSPECIFIED",
      // birthYear: 1990,
    },
    create: {
      email: "admin@test.com",
      passwordHash: adminPasswordHash,
      role: Role.ADMIN,
      firstName: "Teacher",
      lastName: "Admin",
      phone: "99999999",
      // Hvis du har gender/birthYear i schema:
      // gender: "UNSPECIFIED",
      // birthYear: 1990,
    },
  });

  // --- DEMO CUSTOMER (valgfritt, men nyttig) ---
  const userPasswordHash = await bcrypt.hash("password123", 12);

  await prisma.user.upsert({
    where: { email: "user@test.com" },
    update: {
      passwordHash: userPasswordHash,
      role: Role.USER,
      firstName: "Test",
      lastName: "User",
      phone: "88888888",
      // gender: "UNSPECIFIED",
      // birthYear: 2000,
    },
    create: {
      email: "user@test.com",
      passwordHash: userPasswordHash,
      role: Role.USER,
      firstName: "Test",
      lastName: "User",
      phone: "88888888",
      // gender: "UNSPECIFIED",
      // birthYear: 2000,
    },
  });

  // --- SERVICE: Singing (15 min) ---
  await prisma.service.upsert({
    where: { id: "singing-15" },
    update: {
      name: "Sangtime (15 min)",
      description: "15 minutter sangtime + 5 minutter pause",
      durationMin: 15,
      isActive: true,
      // Hvis du har disse i schema:
      // bufferMin: 5,
      // priceOre: 15000,
    },
    create: {
      id: "singing-15",
      name: "Sangtime (15 min)",
      description: "15 minutter sangtime + 5 minutter pause",
      durationMin: 15,
      isActive: true,
      // bufferMin: 5,
      // priceOre: 15000,
    },
  });

  console.log("Seed ferdig 🌱");
  console.log("Admin: admin@test.com / admin123");
  console.log("User:  user@test.com / password123");
  console.log("ServiceId: singing-15");
}

main()
  .catch((e) => {
    console.error("Seed feilet:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
