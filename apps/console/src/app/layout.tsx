import type { Metadata, Viewport } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";
import "./globals.css";

const sans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-sans",
  display: "swap",
});

const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Harness — agent orchestration console",
  description:
    "A durable, approval-gated orchestration backend for LLM agents: leased tasks, transactional outbox, append-only audit trail, and an Odoo ERP integration.",
  openGraph: {
    title: "Agent orchestration harness",
    description: "Approve what an agent drafted and watch the run resume. Reject it and watch nothing get sent.",
    type: "website",
  },
};

export const viewport: Viewport = {
  themeColor: "#362a99",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
