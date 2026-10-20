import type { Metadata } from "next";
import Link from "next/link";
import { Geist, Geist_Mono, Newsreader } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const newsreader = Newsreader({
  variable: "--font-newsreader",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Tera · Stripe-parity pricing simulator",
  description: "Preview every invoice before you change your pricing. Proven to match Stripe on every pull request.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} ${newsreader.variable} h-full antialiased`}>
      <body className="min-h-full sm:p-4">
        <div className="sheet mx-auto max-w-7xl overflow-hidden sm:rounded-2xl">
          <header>
            <nav className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-5 gap-y-2 px-4 py-4 text-[11px] font-medium tracking-wider uppercase">
              <Link href="/" className="mr-2 font-serif text-xl font-semibold tracking-tight normal-case">
                Tera
              </Link>
              <Link href="/simulator">Simulator</Link>
              <Link href="/builder">Builder</Link>
              <Link href="/migrate">Migration</Link>
              <Link href="/parity">Stripe parity</Link>
              <a href="/reference">API</a>
              <a href="/mcp-setup">MCP</a>
              <a href="https://github.com/PugarHuda/tera" className="btn ml-auto text-[11px]">
                GitHub
              </a>
            </nav>
          </header>
          <div className="stripes h-3" aria-hidden="true" />
          <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
          <footer className="mt-8">
            <div className="stripes" aria-hidden="true" />
            <p className="mx-auto max-w-6xl px-4 py-5 text-xs opacity-70">
              Tera · every invoice computed with Stripe&apos;s billing rules and replayed against real Stripe test clocks on every pull request.
            </p>
          </footer>
        </div>
      </body>
    </html>
  );
}
