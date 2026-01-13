import { useEffect, useMemo, useState } from "react";

const API = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

type Me = {
  id: string;
  email: string;
  role: "USER" | "ADMIN";
  createdAt?: string;
};

type Service = {
  id: string;
  name: string;
  description?: string | null;
  durationMin: number;
};

export default function App() {
  // auth
  const [email, setEmail] = useState("user3@test.no");
  const [password, setPassword] = useState("Test1234!");
  const [me, setMe] = useState<Me | null>(null);

  // booking UI
  const [services, setServices] = useState<Service[]>([]);
  const [serviceId, setServiceId] = useState<string>("");
  const [date, setDate] = useState<string>("2026-01-15");
  const [times, setTimes] = useState<string[]>([]);
  const [selectedTime, setSelectedTime] = useState<string>("");

  // ui feedback
  const [status, setStatus] = useState<string>("");
  const [err, setErr] = useState<string>("");

  async function fetchMe() {
    const r = await fetch(`${API}/auth/me`, { credentials: "include" });
    const data = await r.json();
    if (!r.ok) {
      setMe(null);
      return;
    }
    setMe(data);
  }

  async function login() {
    setErr("");
    setStatus("Logger inn…");

    const r = await fetch(`${API}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ email, password }),
    });

    const data = await r.json();
    if (!r.ok) {
      setStatus("");
      setErr(data?.message ?? "Login failed");
      return;
    }

    setStatus("✅ Innlogget");
    await fetchMe();
  }

  // (midlertidig) "logg ut" lokalt. Vi kan lage /auth/logout senere.
  function logoutLocal() {
    setMe(null);
    setStatus("Logget ut (lokalt).");
  }

  // On load: try /me (if cookie already exists)
  useEffect(() => {
    fetchMe();
  }, []);

  // Load services (public)
  useEffect(() => {
    setErr("");
    fetch(`${API}/admin/public/services`)
      .then(async (r) => {
        const data = await r.json();
        if (!r.ok) throw new Error(data?.message ?? `HTTP ${r.status}`);
        setServices(Array.isArray(data) ? data : []);
      })
      .catch((e) => setErr(String(e?.message ?? e)));
  }, []);

  // Load availability when service/date changes
  useEffect(() => {
    if (!serviceId || !date) return;

    setErr("");
    setTimes([]);
    setSelectedTime("");

    fetch(
      `${API}/bookings/availability?serviceId=${encodeURIComponent(
        serviceId
      )}&date=${encodeURIComponent(date)}`
    )
      .then(async (r) => {
        const data = await r.json();
        if (!r.ok) throw new Error(data?.message ?? `HTTP ${r.status}`);
        setTimes(Array.isArray(data?.times) ? data.times : []);
      })
      .catch((e) => setErr(String(e?.message ?? e)));
  }, [serviceId, date]);

  const selectedService = useMemo(
    () => services.find((s) => s.id === serviceId) ?? null,
    [services, serviceId]
  );

  async function book() {
    if (!me) {
      setErr("Du må logge inn for å booke.");
      return;
    }
    if (!serviceId || !date || !selectedTime) return;

    setErr("");
    setStatus("Booking…");

    const r = await fetch(`${API}/bookings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        serviceId,
        date,
        startTime: selectedTime,
        sessions: 1,
      }),
    });

    const data = await r.json();
    if (!r.ok) {
      setStatus("");
      setErr(data?.message ?? `HTTP ${r.status}`);
      return;
    }

    setStatus("✅ Booket!");

    // Refresh availability so the booked time disappears
    const avail = await fetch(
      `${API}/bookings/availability?serviceId=${encodeURIComponent(
        serviceId
      )}&date=${encodeURIComponent(date)}`
    ).then((rr) => rr.json());

    setTimes(Array.isArray(avail?.times) ? avail.times : []);
    setSelectedTime("");
  }

  return (
    <div style={{ fontFamily: "system-ui", padding: 24, maxWidth: 760 }}>
      <h1>Booking System</h1>

      <p>
        API: <code>{API}</code>
      </p>

      {err && <p style={{ color: "crimson" }}>Error: {err}</p>}
      {status && <p>{status}</p>}

      {/* LOGIN BOX */}
      <div style={{ padding: 12, border: "1px solid #ddd", borderRadius: 8 }}>
        <h3 style={{ marginTop: 0 }}>Innlogging</h3>

        {me ? (
          <>
            <p>
              Innlogget som <strong>{me.email}</strong> ({me.role})
            </p>
            <button type="button" onClick={logoutLocal}>
              Logg ut
            </button>
          </>
        ) : (
          <div style={{ display: "grid", gap: 8 }}>
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="email"
            />
            <input
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="password"
              type="password"
            />
            <button type="button" onClick={login}>
              Logg inn
            </button>
          </div>
        )}
      </div>

      {/* BOOKING BOX */}
      <div style={{ marginTop: 16, display: "grid", gap: 12 }}>
        <label>
          Service
          <br />
          <select
            value={serviceId}
            onChange={(e) => setServiceId(e.target.value)}
            style={{ width: "100%", padding: 8 }}
          >
            <option value="">Velg service…</option>
            {services.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.durationMin} min)
              </option>
            ))}
          </select>
        </label>

        <label>
          Dato
          <br />
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            style={{ width: "100%", padding: 8 }}
          />
        </label>

        {selectedService && (
          <div style={{ padding: 12, border: "1px solid #ddd", borderRadius: 8 }}>
            <strong>{selectedService.name}</strong>
            {selectedService.description ? <p>{selectedService.description}</p> : null}

            <p style={{ marginTop: 8 }}>Velg tid:</p>

            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {times.map((t) => {
                const active = t === selectedTime;
                return (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setSelectedTime(t)}
                    style={{
                      border: "1px solid #ccc",
                      borderRadius: 999,
                      padding: "6px 10px",
                      fontSize: 14,
                      cursor: "pointer",
                      background: active ? "#111" : "white",
                      color: active ? "white" : "black",
                    }}
                  >
                    {t}
                  </button>
                );
              })}
              {serviceId && times.length === 0 ? <em>Ingen tider.</em> : null}
            </div>

            <div style={{ marginTop: 12, display: "flex", gap: 8, alignItems: "center" }}>
              <button
                type="button"
                disabled={!selectedTime}
                onClick={book}
                style={{
                  padding: "10px 14px",
                  borderRadius: 8,
                  border: "1px solid #ccc",
                  cursor: selectedTime ? "pointer" : "not-allowed",
                }}
              >
                Book
              </button>

              {selectedTime ? <span>Valgt: {selectedTime}</span> : null}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
