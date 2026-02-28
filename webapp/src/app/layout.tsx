import type { Metadata } from "next";
import { Inter } from 'next/font/google';
import "./globals.css";

const inter = Inter({
  subsets: ['latin'],
  display: 'swap',
});

export const metadata: Metadata = {
  title: "AI Video Pipeline — Cloud Studio",
  description: "Generate AI videos entirely in the cloud. Script → Voice → Images → Video — zero local compute.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.className}>
      <body>
        <header className="app-header">
          <div style={{ maxWidth: 1280, margin: '0 auto', padding: '0 24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span style={{ fontSize: '1.6rem' }}>🎬</span>
              <span className="logo-text">AI Video Pipeline</span>
            </div>
            <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)', background: 'rgba(99,102,241,0.1)', padding: '4px 12px', borderRadius: 20, fontWeight: 500 }}>
              ☁️ 100% Cloud
            </span>
          </div>
        </header>
        <main style={{ position: 'relative', zIndex: 1 }}>
          {children}
        </main>
      </body>
    </html>
  );
}
