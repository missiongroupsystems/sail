import { redirect } from "next/navigation";

/** Today is the home page (design 3.2). */
export default function Home() {
  redirect("/today");
}
