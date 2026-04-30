import type { Metadata } from "next";
import "./globals.css";
import { UploadProvider } from "./upload-context";
import ChatPanel from "@/components/ChatPanel";
import AppNav from "@/components/AppNav";
import { config } from "@/lib/config";

export const metadata: Metadata = {
  title: config.company.name + " — Van Scheduler",
  description: "Van scheduling and booking management for " + config.company.name,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className="antialiased"
      >
        <UploadProvider>
          <div className="min-h-screen flex flex-col" style={{ background: "var(--bg-base)" }}>
            <AppNav />
            <main className="flex-1">
              {children}
            </main>
          </div>
        </UploadProvider>
        <ChatPanel />
      </body>
    </html>
  );
}
