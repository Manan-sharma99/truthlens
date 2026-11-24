import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "TruthLens — Evidence-Based Fact-Checking & Prompt Engineering Workbench",
  description:
    "AI-powered, evidence-grounded fact-checking workbench with multi-stage prompt engineering, independent verification, citation validation, and systematic evaluation.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-[#090e1a] text-slate-200 selection:bg-teal-500/30 selection:text-teal-200">
        {children}
      </body>
    </html>
  );
}
