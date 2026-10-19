import express, { Request, Response, NextFunction } from 'express';
import joi from 'joi';
import { requireRole } from './rbac';
import { getOptions, runUpdates } from '../updates/service';
import { UpdateRequest, messageOf } from '../updates/model';

export function requireSameOrigin(
    req: Request,
    res: Response,
    next: NextFunction,
) {
    const origin = req.get('origin');
    if (origin) {
        try {
            if (new URL(origin).host !== req.get('host'))
                return res
                    .status(403)
                    .json({ error: 'Cross-origin update request rejected' });
        } catch {
            return res.status(403).json({ error: 'Invalid request origin' });
        }
    }
    if (
        ['POST', 'PUT', 'PATCH'].includes(req.method) &&
        !req.is('application/json')
    )
        return res.status(415).json({ error: 'Use application/json' });
    return next();
}
export const updateSchema = joi
    .object({
        containerIds: joi
            .array()
            .items(joi.string().max(256).required())
            .min(1)
            .max(100)
            .unique()
            .required(),
        triggerId: joi.string().max(200).required(),
        scope: joi.string().valid('container', 'stack').required(),
    })
    .unknown(false);
export function init() {
    const router = express.Router();
    router.get(
        '/options',
        requireRole(['admin', 'rw', 'ro'], 'read'),
        async (_req, res) => {
            try {
                res.json(await getOptions());
            } catch (error) {
                res.status(500).json({ error: messageOf(error) });
            }
        },
    );
    router.post(
        '/run',
        requireRole(['admin', 'rw'], 'write'),
        requireSameOrigin,
        async (req, res) => {
            const validated = updateSchema.validate(req.body);
            if (validated.error)
                return res.status(400).json({ error: validated.error.message });
            try {
                return res.json(
                    await runUpdates(validated.value as UpdateRequest),
                );
            } catch (error) {
                return res.status(400).json({ error: messageOf(error) });
            }
        },
    );
    return router;
}
