import type { Express, NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import type { Db } from '../db.js';
import {
  REPORT_PRESETS,
  RepReportError,
  campaignStatsCsv,
  dailyStatsCsv,
  repReport,
  teamStatsCsv,
  type CsvExport
} from './rep-reporting.js';

/**
 * HTTP surface for per-rep reporting and the stats exports (TRV-046, TRV-049).
 *
 * Mounted by `createApp` after `requireSession`, so every handler reads the
 * caller's workspace from `req.auth` and never from the query. Read-only: no
 * route here writes anything.
 */

type ReportRequest = Request & { auth?: { workspaceId: string } };

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

const reportQuerySchema = z.object({
  range: z.enum(REPORT_PRESETS).optional(),
  /** First local date counted, inclusive. */
  from: DATE.optional(),
  /** First local date NOT counted, exclusive. */
  to: DATE.optional(),
  seatKey: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/)
    .optional(),
  campaignId: z.string().trim().min(1).max(120).optional()
});

/** Repeated (`memberIds=a&memberIds=b`) or comma-separated; at most 200 either way. */
const memberIdsSchema = z
  .union([z.string(), z.array(z.string())])
  .transform((value) =>
    (Array.isArray(value) ? value : value.split(',')).map((entry) => entry.trim()).filter(Boolean)
  )
  .pipe(z.array(z.string().max(120)).min(1, 'Select at least one member to export.').max(200));

function parseReportQuery(query: unknown) {
  const input = reportQuerySchema.parse(query);
  return {
    preset: input.range,
    from: input.from,
    to: input.to,
    seatKey: input.seatKey,
    campaignId: input.campaignId
  };
}

function route(handler: (req: ReportRequest, res: Response) => Promise<unknown>) {
  return async (req: ReportRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      await handler(req, res);
    } catch (error) {
      if (error instanceof RepReportError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: 'Invalid request', issues: error.issues });
        return;
      }
      next(error);
    }
  };
}

function sendCsv(res: Response, file: CsvExport): void {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(file.csv);
}

export function registerLinkedInReportRoutes(app: Express, db: Db): void {
  app.get(
    '/api/linkedin/manager/reports',
    route(async (req, res) => {
      res.json(await repReport(db, req.auth!.workspaceId, parseReportQuery(req.query), new Date()));
    })
  );

  app.get(
    '/api/linkedin/manager/reports/daily.csv',
    route(async (req, res) => {
      sendCsv(
        res,
        await dailyStatsCsv(db, req.auth!.workspaceId, parseReportQuery(req.query), new Date())
      );
    })
  );

  app.get(
    '/api/linkedin/manager/reports/campaigns/:id/daily.csv',
    route(async (req, res) => {
      const { campaignId: _ignored, ...query } = parseReportQuery(req.query);
      const file = await campaignStatsCsv(
        db,
        req.auth!.workspaceId,
        String(req.params.id),
        query,
        new Date()
      );
      if (!file) throw new RepReportError('Campaign not found.', 404);
      sendCsv(res, file);
    })
  );

  app.get(
    '/api/linkedin/manager/reports/team.csv',
    route(async (req, res) => {
      const { memberIds: rawMemberIds, ...rest } = req.query as Record<string, unknown>;
      const memberIds = memberIdsSchema.parse(rawMemberIds ?? []);
      sendCsv(
        res,
        await teamStatsCsv(
          db,
          req.auth!.workspaceId,
          { ...parseReportQuery(rest), memberIds },
          new Date()
        )
      );
    })
  );
}
