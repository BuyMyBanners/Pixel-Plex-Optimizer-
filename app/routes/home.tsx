import type { Route } from "./+types/home"
import { Welcome } from "../welcome/welcome"

export function meta({}: Route.MetaArgs) {
  return [{ title: "Pixel Plex Optimizer" }, { name: "description", content: "Welcome to Pixel Plex Optimizer!" }]
}

export default function Home() {
  return <Welcome />
}
