import { FastifyReply, FastifyRequest } from 'fastify';
import { env } from '../config/env';
import { evaluateCompliance, type ComplianceReport } from '../services/compliance';

export function getLaunchCompliance() {
  return evaluateCompliance();
}

export function requireLaunchReady(_req: FastifyRequest, reply: FastifyReply): _req is FastifyRequest {
  if (!env.COMPLIANCE_ENFORCE_LAUNCH) return true;

  const report: ComplianceReport = evaluateCompliance();
  if (report.launchReady) return true;

  reply.status(423).send({
    error: 'launch_not_ready',
    message: 'Compliance checks failed and launch enforcement is enabled.',
    report,
  });
  return false;
}
