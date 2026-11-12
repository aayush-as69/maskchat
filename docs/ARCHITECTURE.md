# MaskChat Architecture

## High-level flow

```text
Institution authentication
          |
          v
     Identity shield
          |
          +--> stable internal identity
          |
          +--> daily public alias
          |
          v
      Topic matching
          |
          v
    Session creation
          |
          v
 Socket.IO realtime room
          |
          +--> moderation filter
          |
          +--> report / feedback
          v
       Session end
```

## Identity boundary

The system separates verified identity from the identity shown to the other participant. The public alias is derived from a secret. A separate internal identity reference is used for moderation and rate limiting.

## Matching

Mentors publish availability, tags, expertise, year and optional capacity. Seekers are matched by topic overlap and mentor feedback, with a queue when no mentor is immediately available. Matching is isolated per institution.

## Realtime

Socket.IO rooms carry session messages. A short rejoin grace period allows a participant to reconnect after a refresh.

## Moderation

Messages are checked before delivery. Reports can include visible message evidence for moderator review.