import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "FraudLens",
  description: "AI-assisted fraud alert triage for bank fraud analysts",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
