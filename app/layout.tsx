import type { Metadata } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import { Bricolage_Grotesque, Geist, Geist_Mono } from "next/font/google";
import { Toaster } from "@/components/ui/sonner";
import { ConvexClientProvider } from "@/lib/auth/convex-client-provider";
import { appConfig, isBackendConfigured } from "@/lib/config";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const display = Bricolage_Grotesque({
  variable: "--font-display",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: { default: `${appConfig.name} — ${appConfig.tagline}`, template: `%s · ${appConfig.name}` },
  description:
    "Replace paper visitor books and manual attendance registers with a secure, auditable digital system.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  // Without credentials the public site still renders; signed-in areas show
  // setup instructions instead (see components/layout/setup-required.tsx).
  const content = isBackendConfigured ? (
    <ClerkProvider>
      <ConvexClientProvider>{children}</ConvexClientProvider>
    </ClerkProvider>
  ) : (
    children
  );

  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${display.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-background text-foreground">
        {content}
        <Toaster />
      </body>
    </html>
  );
}
