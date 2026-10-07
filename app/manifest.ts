import type { MetadataRoute } from "next"

/** Web app manifest: what the installed app is called and how it opens. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "Taskly",
    short_name: "Taskly",
    description: "Tasks and meetings for your workspace.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#ffffff",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      {
        src: "/icons/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  }
}
