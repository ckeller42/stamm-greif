import type { Access } from 'payload'

export const authenticated: Access = ({ req }) => Boolean(req.user)
export const isAdmin: Access = ({ req }) => req.user?.role === 'admin'
export const isKuratorOrAdmin: Access = ({ req }) =>
  req.user?.role === 'admin' || req.user?.role === 'kurator'
export const isAdminOrSelf: Access = ({ req, id }) =>
  req.user?.role === 'admin' || (req.user != null && String(req.user.id) === String(id))
