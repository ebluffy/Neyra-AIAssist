"""Short-lived web identity, independent of the API bearer-token permission role."""
from __future__ import annotations

import logging
import os
from dataclasses import dataclass, replace
from typing import Any, Optional

import jwt

from core.runtime.identity import UnifiedIdentityMapper


logger = logging.getLogger("neyra.web_identity")


class InvalidWebIdentity(ValueError):
    """Deliberately contains no token, claims or secret for public error responses."""


@dataclass(frozen=True)
class WebIdentity:
    person_id: str
    role: str
    name: str
    user_id: str
    discord_id: Optional[str] = None


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
        discord_id = claims.get("discord_id")
        if discord_id is not None:
            if not isinstance(discord_id, str) or not discord_id.strip() or len(discord_id) > 64:
                raise InvalidWebIdentity()
            discord_id = discord_id.strip()
        return WebIdentity(
            person_id=UnifiedIdentityMapper.resolve("web", sub),
            role=role, name=name, user_id=sub, discord_id=discord_id,
        )
    except (jwt.PyJWTError, KeyError, TypeError, ValueError) as exc:
        raise InvalidWebIdentity() from exc


def _sync_web_display_name(hub: Any, person_id: str, identity: WebIdentity) -> None:
    """Sync the JWT name unless an admin/custom dossier name must win."""
    from core.memory.person_profile import clean_speaker_label

    name = clean_speaker_label(identity.name)
    if not name or not person_id:
        return
    try:
        person = hub.sqlite.get_person(person_id)
        current = str((person or {}).get("display_name") or "").strip()
        account = hub.sqlite.get_account("web", identity.user_id)
        web_display = str((account or {}).get("display_name") or "").strip()
        email_like = "@" in current and " " not in current
        if current and current != web_display and not email_like:
            # An admin or the user set a name that no longer mirrors the JWT.
            return
        if name != web_display:
            hub.sqlite.upsert_person_account(
                person_id=person_id,
                platform="web",
                platform_user_id=identity.user_id,
                display_name=name,
            )
        accounts = hub.sqlite.list_accounts_for_person(person_id)
        if not any(str(a.get("platform") or "").lower() == "discord" for a in accounts):
            if not current or email_like or current == web_display:
                hub.sqlite.upsert_person(person_id=person_id, display_name=name)
    except Exception:
        logger.warning("web display name sync failed | person=%s", person_id)


def provision_web_identity(hub: Any, identity: WebIdentity) -> WebIdentity:
    """Map a signed web user to the linked Discord person when the account is bound."""
    from core.memory.person_profile import clean_speaker_label

    if hub is None:
        return identity
    retry = getattr(hub, "retry_semantic_restores", None)
    if callable(retry):
        try:
            retry()
        except Exception:
            logger.warning("semantic restore retry hook failed")
    account = hub.sqlite.get_account("web", identity.user_id)
    if account is not None:
        _sync_web_display_name(
            hub, str(account.get("person_id") or "").strip(), identity
        )
    discord_person = None
    if identity.discord_id:
        discord_account = hub.sqlite.get_account("discord", identity.discord_id)
        if discord_account is not None:
            discord_person = str(discord_account.get("person_id") or "").strip() or None
    if discord_person:
        if account is None:
            hub.sqlite.upsert_person_account(
                person_id=discord_person,
                platform="web",
                platform_user_id=identity.user_id,
                display_name=clean_speaker_label(identity.name) or None,
            )
            return replace(identity, person_id=discord_person)
        web_person = str(account.get("person_id") or "").strip()
        if web_person == discord_person:
            return replace(identity, person_id=discord_person)
        accounts = hub.sqlite.list_accounts_for_person(web_person)
        only_web_account = len(accounts) == 1 and str(accounts[0].get("platform") or "") == "web"
        already_merged = hub.sqlite.merge_history_exists(discord_person, web_person)
        if only_web_account and not already_merged:
            try:
                hub.merge_people(discord_person, web_person, reason="web_discord_link")
                return replace(identity, person_id=discord_person)
            except KeyError:
                current = hub.sqlite.get_account("web", identity.user_id)
                if current is not None and str(current.get("person_id") or "") == discord_person:
                    return replace(identity, person_id=discord_person)
        if not hub.sqlite.merge_proposal_exists(discord_person, web_person):
            try:
                hub.propose_people_merge(discord_person, web_person, reason="web_discord_link")
            except (KeyError, ValueError):
                logger.warning("web_discord_link proposal failed | persons=%s/%s", discord_person, web_person)
        return replace(identity, person_id=web_person)
    if account is not None:
        person_id = account.get("person_id")
    else:
        row = hub.ensure_person_for_account(
            platform="web",
            platform_user_id=identity.user_id,
            display_name=clean_speaker_label(identity.name) or None,
        )
        person_id = row.get("id")
    if not isinstance(person_id, str) or not person_id.strip():
        raise RuntimeError("Invalid web account owner")
    return replace(identity, person_id=person_id)
