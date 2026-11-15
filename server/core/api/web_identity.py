"""Short-lived web identity, independent of the API bearer-token permission role."""
from __future__ import annotations

import os
from dataclasses import dataclass

import jwt

from core.runtime.identity import UnifiedIdentityMapper


class InvalidWebIdentity(ValueError):
    """Deliberately contains no token, claims or secret for public error responses."""


@dataclass(frozen=True)
class WebIdentity:
    person_id: str
    role: str
    name: str
    user_id: str


def verify_web_identity(token: str) -> WebIdentity:
    secret = os.environ.get("NEYRA_IDENTITY_JWT_SECRET", "")
    issuer = os.environ.get("NEYRA_IDENTITY_JWT_ISSUER", "").strip()
    try:
        strong_secret = len(secret.encode("utf-8")) >= 32 and bool(secret.strip())
    except UnicodeError:
        strong_secret = False
    if not strong_secret or not issuer or not token or len(token) > 8192:
        raise InvalidWebIdentity()
    try:
        # Fixed allowlist; never choose an algorithm/key from untrusted JWT headers.
        decoded = jwt.decode_complete(
            token, secret, algorithms=["HS256"], issuer=issuer,
            options={"require": ["iss", "sub", "iat", "exp", "role", "name"]},
        )
        header, claims = decoded["header"], decoded["payload"]
        if "crit" in header or "b64" in header:
            raise InvalidWebIdentity()
        sub, role, name = claims["sub"], claims["role"], claims["name"]
        issued, expires = claims["iat"], claims["exp"]
        # Integer NumericDate only: reject bool/string coercions as well as future iat
        # and expired exp (the latter two are also checked by PyJWT, with zero leeway).
        if type(issued) is not int or type(expires) is not int or not 0 < expires - issued <= 60:
            raise InvalidWebIdentity()
        if not isinstance(sub, str) or not sub.strip():
            raise InvalidWebIdentity()
        if role not in ("admin", "user") or not isinstance(name, str):
            raise InvalidWebIdentity()
        return WebIdentity(
            person_id=UnifiedIdentityMapper.resolve("web", sub),
            role=role, name=name, user_id=sub,
        )
    except (jwt.PyJWTError, KeyError, TypeError, ValueError) as exc:
        raise InvalidWebIdentity() from exc
