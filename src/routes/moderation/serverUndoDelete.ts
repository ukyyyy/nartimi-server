import { Request, Response, Router } from 'express';
import { body } from 'express-validator';
import { prisma } from '../../common/database';
import { customExpressValidatorResult, generateError } from '../../common/errorHandler';

import { authenticate } from '../../middleware/authenticate';
import { isModMiddleware } from './isModMiddleware';
import { generateId } from '../../common/flakeId';
import { ModAuditLogType } from '../../common/ModAuditLog';
import { checkUserPassword } from '../../services/UserAuthentication';
import { deleteServerCache } from '../../cache/ServerCache';
import { emitServerRemoveScheduleDelete, emitServerScheduleDelete } from '../../emits/Server';

export function serverUndoDelete(Router: Router) {
  Router.delete<any>('/moderation/servers/:serverId/schedule-delete', authenticate(), isModMiddleware, body('password').isLength({ min: 4, max: 72 }).withMessage('Password must be between 4 and 72 characters long.').isString().withMessage('Password must be a string!').not().isEmpty().withMessage('Password is required'), route);
}

interface Body {
  password: string;
}

interface Params {
  serverId: string;
}

async function route(req: Request<Params, unknown, Body>, res: Response) {
  const validateError = customExpressValidatorResult(req);
  if (validateError) {
    return res.status(400).json(validateError);
  }

  const account = await prisma.account.findFirst({
    where: { id: req.userCache.account!.id },
    select: { password: true },
  });
  if (!account) return res.status(404).json(generateError('Something went wrong. Try again later.'));

  const isPasswordValid = await checkUserPassword(account.password, req.body.password);
  if (!isPasswordValid) return res.status(403).json(generateError('Invalid password.', 'password'));

  const server = await prisma.server.findUnique({
    where: { id: req.params.serverId },
    include: { scheduledForDeletion: true },
  });

  if (!server) return res.status(404).json(generateError('Server does not exist.'));
  if (!server.scheduledForDeletion) return res.status(404).json(generateError('Server is already not scheduled to delete.'));

  const scheduledDeletion = await prisma.scheduleServerDelete
    .delete({
      where: { serverId: server.id },
    })
    .catch((e) => {
      console.error(e);
      return null;
    });
  if (!scheduledDeletion) {
    return res.status(500).json(generateError('Failed to de-schedule server deletion.'));
  }

  await prisma.modAuditLog.create({
    data: {
      id: generateId(),
      actionType: ModAuditLogType.serverDeleteUndo,
      actionById: req.userCache.id,
      serverName: server.name,
      serverId: server.id,
      userId: server.createdById,
    },
  });

  await deleteServerCache(server.id);

  emitServerRemoveScheduleDelete(server.id);

  res.status(200).json({ success: true });
}
