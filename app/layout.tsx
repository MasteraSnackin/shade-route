import type { Metadata } from "next";
import { headers } from "next/headers";
import { Geist } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const title = "ShadeRoute — less direct sun on foot";
const description =
  "Compare walking time with estimated direct-sun exposure on two London hospital corridors.";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost:3000";
  const forwardedProtocol = requestHeaders.get("x-forwarded-proto")?.split(",")[0];
  const protocol = forwardedProtocol === "http" || host.startsWith("localhost") ? "http" : "https";
  const origin = `${protocol}://${host}`;
  const image = new URL("/og-v2.png", origin).toString();

  return {
    title,
    description,
    icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
    openGraph: {
      type: "website",
      title,
      description,
      images: [{ url: image, width: 1732, height: 908, alt: "ShadeRoute: Plan a walk with less direct sun." }],
    },
    twitter: { card: "summary_large_image", title, description, images: [image] },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${geistSans.variable} antialiased`}>
        {children}
      </body>
    </html>
  );
}
