import type { TicketBrand } from "@resolve/contracts";
import { useEffect, useState } from "react";

import type { SkillStatus, WorkerClient } from "../../api/worker-client";

export type SkillsWorker = Pick<WorkerClient, "listSkills" | "checkSkill">;

interface SkillsManagerProps {
  worker: SkillsWorker;
  ticketId: number;
  brand: TicketBrand;
}

export function SkillsManager({ worker, ticketId, brand }: SkillsManagerProps) {
  const [skills, setSkills] = useState<SkillStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [health, setHealth] = useState<Record<string, string>>({});

  useEffect(() => {
    let active = true;
    void worker
      .listSkills()
      .then((result) => {
        if (active) setSkills(result.skills);
      })
      .catch(() => {
        if (active) setError("Skill status could not be loaded.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [worker]);

  async function check(skill: SkillStatus) {
    setHealth((current) => ({
      ...current,
      [skill.id]: "Checking…",
    }));
    try {
      const result = await worker.checkSkill(skill.id, ticketId, brand);
      setHealth((current) => ({
        ...current,
        [skill.id]: result.message,
      }));
    } catch {
      setHealth((current) => ({
        ...current,
        [skill.id]: "Health check failed.",
      }));
    }
  }

  return (
    <section className="skills-manager" aria-busy={loading}>
      <div className="view-heading">
        <span className="eyebrow">Operations</span>
        <h2>Skills manager</h2>
        <p>Capabilities, configuration state, and connection health.</p>
      </div>
      {error && <div className="error-notice">{error}</div>}
      <div className="skill-list">
        {skills.map((skill) => (
          <article className="skill-card" key={skill.id}>
            <div className="skill-mark" aria-hidden="true">
              {skill.name.slice(0, 1)}
            </div>
            <div className="skill-detail">
              <div>
                <h3>{skill.name}</h3>
                <span>v{skill.version}</span>
              </div>
              <p>
                {skill.tools.length}{" "}
                {skill.tools.length === 1 ? "tool" : "tools"} ·{" "}
                {skill.tools.every((tool) => tool.risk === "read")
                  ? "Read only"
                  : "Includes writes"}
              </p>
              {skill.connections && (
                <ul className="skill-connections" aria-label="Connections">
                  {skill.connections.map((connection) => (
                    <li key={connection.id}>
                      <span>{connection.name}</span>
                      <strong>
                        {connection.configured ? "Ready" : "Needs setup"}
                      </strong>
                    </li>
                  ))}
                </ul>
              )}
              {health[skill.id] && (
                <span className="health-message" role="status">
                  {health[skill.id]}
                </span>
              )}
            </div>
            <div className="skill-actions">
              <span
                className={`readiness ${
                  skill.configured ? "readiness--ready" : ""
                }`}
              >
                {skill.configured ? "Ready" : "Not configured"}
              </span>
              <button
                type="button"
                disabled={!skill.configured}
                onClick={() => void check(skill)}
              >
                Test
              </button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
