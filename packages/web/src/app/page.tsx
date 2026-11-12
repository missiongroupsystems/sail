import { redirect } from "next/navigation";

/** Today is the home page. */
export default function Home() {
  redirect("/today");
}
