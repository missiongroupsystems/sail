import type { ExtensionPages } from "../../src/extensions/types";
import Page from "./Page";

const pages: ExtensionPages = { open: Page, managers: Page, "admins/only": Page };
export default pages;
