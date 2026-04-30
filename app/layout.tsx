import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { UploadProvider } from "./upload-context";
import ChatPanel from "@/components/ChatPanel";
import AppNav from "@/components/AppNav";
import { config } from "@/lib/config";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

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
      {/* Apply saved theme before paint to avoid flash */}
      <script dangerouslySetInnerHTML={{ __html: `(function(){try{if(localStorage.getItem('theme')==='light')document.documentElement.classList.add('light')}catch(e){}})()` }} />
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
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
