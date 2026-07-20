import { SkillRegistry } from "@resolve/skill-sdk";

import type { SkillDefinition } from "@resolve/skill-sdk";
import { shipstationSkill } from "./shipstation";
import { woocommerceSkill } from "./woocommerce";
import { zendeskSkill } from "./zendesk";

export const skills: readonly SkillDefinition[] = [
  zendeskSkill,
  woocommerceSkill,
  shipstationSkill,
];
export const skillRegistry = new SkillRegistry(skills);
