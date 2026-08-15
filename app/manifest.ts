import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "ShadeRoute London pilot",
    short_name: "ShadeRoute",
    description: "Compare walking time with modelled clear-sky direct-sun exposure.",
    lang: "en-GB",
    dir: "ltr",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#f5f3ec",
    theme_color: "#075f56",
    orientation: "any",
    categories: ["navigation", "utilities"],
    prefer_related_applications: false,
    shortcuts: [
      {
        name: "Plan a walking route",
        short_name: "Plan route",
        description: "Compare walking time with modelled direct-sun exposure.",
        url: "/#route-planner",
        icons: [{ src: "/app-icon-192.png", sizes: "192x192", type: "image/png" }],
      },
      {
        name: "Open field-validation tools",
        short_name: "Field tools",
        description: "Open the model-first fixed-point and route-walk tools.",
        url: "/#method",
        icons: [{ src: "/app-icon-192.png", sizes: "192x192", type: "image/png" }],
      },
    ],
    icons: [
      {
        src: "/app-icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/app-icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/app-icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
