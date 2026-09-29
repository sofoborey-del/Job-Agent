# Reed Jobseeker API: the permission question, and a message you can send

Dated 2026-09-29. No Reed integration exists in this repository and none should be written until the
question below has an answer. This file is a proposal and a draft message; the agent has no outbound
message capability, so you send it yourself.

## Why Reed is worth adding

The two discovery sources that exist are the manual MyJobScotland flow and the Adzuna search API.
Adzuna returns only "a snipped of the job description" by its own documentation, so its leads can be
listed but never scored — on the local database today that is forty-five of fifty-five tracked
vacancies sitting in "requirements never read".

Reed documents two endpoints rather than one:

| Endpoint                                             | What it gives                                                                                                                                                                                                         |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET https://www.reed.co.uk/api/{version}/search`    | Job id, employer, title, description, location, minimum and maximum salary. Filters for keywords, location, distance, employment type, salary range, direct-employer versus agency, and pagination up to 100 results. |
| `GET https://www.reed.co.uk/api/{version}/jobs/{id}` | A fuller record: yearly salary figures, currency, salary type, contract type, job type, expiry date, the external application URL and the reed.co.uk URL.                                                             |

Authentication is HTTP Basic with an API key as the username and an empty password.

That second endpoint is the reason this is worth doing. A documented way to fetch a complete advert
is the difference between a lead the agent can only list and a vacancy it can read criteria from and
check against the profile. It would also, for adverts that instruct it, feed the email-application
path.

Source: <https://www.reed.co.uk/developers/jobseeker>

## The problem, and it is not a technical one

**That page states no terms of use and no rate limit for the Jobseeker API.** It explains how to call
the endpoints and stops there. The 200-requests-per-hour figure that appears elsewhere on the site
belongs to their recruiter and courses APIs, not this one.

This project's rule is that a source may only be switched on against a reviewed, current,
action-appropriate site policy with an evidence URL a person can point at. Adzuna satisfied that
because its developer terms explicitly list personal research among the permitted uses. Reed
publishes nothing equivalent that I could find, so a Reed policy row would have to cite either a
terms page that does exist and I missed, or a written answer from Reed.

Two other things to establish in the same message, because both change the design:

1. **Whether the search endpoint's description is complete or truncated.** Their documentation does
   not say. If it is truncated, every Reed lead needs the same excerpt-only treatment Adzuna gets, and
   the details endpoint becomes essential rather than merely useful.
2. **The permitted request rate**, so the reviewed rate limiter is set from their figure rather than a
   guess.

## Draft message

Send this yourself, to whatever contact address the developer pages give. Nothing in it identifies
this repository or your profile.

> Subject: Jobseeker API — permitted use for a personal job search, and rate limits
>
> Hello,
>
> I am an individual job seeker. I have written a small private tool that runs on my own computer and
> helps me keep track of vacancies I might apply for. It is not a product, it is not published, it has
> no other users, and it displays nothing publicly — it only shows me listings on my own screen.
>
> I would like to use the Jobseeker API for that, and I would rather ask than assume. Three questions:
>
> 1. Is this kind of private, personal, non-commercial use permitted? If there are terms of use for the
>    Jobseeker API specifically, could you point me at them? I could not find them on
>    <https://www.reed.co.uk/developers/jobseeker>.
> 2. Is the `description` field in a `/search` response the complete job description, or an extract? I
>    ask because I do not want to draw conclusions from a partial advert, and if it is an extract I
>    will fetch the full record from `/jobs/{id}` instead.
> 3. What request rate should I keep to? I would rather set a conservative limit from your figure than
>    guess. My tool would poll a handful of searches a few times a day at most.
>
> If personal use of this kind is not something you permit, please just say so and I will not use it.
>
> Thank you,
>
> [your name]

## What happens with each answer

| Their answer                                    | What follows                                                                                                                                                                            |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Permitted, with terms or a written yes          | Add a `public_api` source and a site-policy migration citing that evidence, with their rate limit. Then a purpose-written reader, as `apiReaderDomains` requires.                       |
| Permitted, but search descriptions are extracts | The same, with every Reed lead marked `descriptionCompleteness: 'snippet'`, and the details endpoint used to complete a lead the way the official-advert route completes an Adzuna one. |
| Not permitted, or no reply                      | Nothing is built. Reed stays absent, exactly as S1Jobs, Totaljobs and Indeed do, and for the same reason.                                                                               |

Do not write the reader before the answer arrives. A source with no permission a person can point at
is the thing the site-policy registry exists to refuse.
