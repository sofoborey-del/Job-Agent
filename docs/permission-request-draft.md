# Draft permission request — not sent

This is a draft for the user to review, edit and send themselves. **Nothing here has been sent.**
The agent does not send email and has no outbound message capability.

## Who to send it to

MyJobScotland is run by COSLA (the Convention of Scottish Local Authorities) and the application
flow is operated on Lumesse/TalentLink. Permission for one is not permission for the other, and the
recruiting council is the data controller for your application. In practice, send it to whichever
of these you can reach, in this order:

1. **The recruiting council's HR or recruitment team** for the specific vacancy you want to apply
   for. They control the process and can give you a usable answer fastest.
2. **MyJobScotland support**, via the contact route on myjobscotland.gov.uk, for a platform-level
   answer.

Keep the reply. A written answer is the evidence that would let the adapter be switched on; a
verbal "should be fine" is not enough to change a site policy.

## The message

> Subject: Accessibility question — using my own assistive tool to fill in my application
>
> Hello,
>
> I am applying for jobs through MyJobScotland and I would like to check something before I use a
> tool to help me.
>
> I have set up a personal piece of software on my own computer that helps me keep track of
> vacancies and fill in repetitive application fields. I want to be clear about exactly what it
> would and would not do:
>
> - It would fill in only my own factual details — my name, contact details, employment history and
>   qualifications — from information I have entered and checked myself.
> - I would sign in myself. It would never handle my password, any verification code, or any
>   security check.
> - It would stop and hand over to me for every equal-opportunities question, every declaration,
>   every consent tick and anything about disclosure or right to work.
> - I would read the completed form myself and press submit myself. The tool cannot submit an
>   application; it has no ability to do so.
> - It would not create claims about my experience or qualifications. Anything it cannot take
>   directly from what I have entered, it asks me.
> - It runs only on my own machine, for my own applications. It is not a commercial product and it
>   does not collect or share anything about other candidates.
>
> My questions are:
>
> 1. Is it acceptable for me to use a tool like this to fill in my own application forms on your
>    system?
> 2. If it is, is there anything you would want me to do differently, or any rate of use I should
>    stay within?
> 3. If it is not acceptable, I will simply not use it for your forms — I would just like to know
>    where I stand.
>
> I am asking rather than assuming, because I would rather be told no than cause a problem.
>
> Thank you for your time.
>
> [Your name]
> [Your email address]

## Why it is phrased this way

- **It asks, rather than announcing.** A message that says "I will be using automation" invites a
  refusal on principle. This one makes a yes easy to give and a no easy to state.
- **It leads with what the tool will not do.** Login, verification, declarations, consent and
  submission are the things a recruiter would worry about, so they are ruled out before the request
  is made.
- **It says submission is impossible, not merely disabled.** That is true of this implementation:
  the real-site adapter cannot express a submit action. Do not weaken that sentence, because it is
  load-bearing.
- **It avoids the words "bot", "scraper" and "automation"** in the opening, which are read as a
  policy problem rather than an accessibility question.
- **It does not ask for an API, a partnership or bulk access.** The request is the narrowest one
  that would unblock the work.

## What to do with the answer

| Answer                           | What it means here                                                                                                                                                                         |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Written yes, with any conditions | Record it as the evidence URL or document on the site policy, set `termsStatus` accordingly and raise a new reviewed policy version. Only then may `executionMode` move to `prefill_only`. |
| No                               | Leave the adapter disabled permanently for that domain and use the preparation panel to copy details across by hand.                                                                       |
| No reply after a reasonable wait | Treat as no. Silence is not permission.                                                                                                                                                    |

Do not switch prefill on from a verbal answer, an inference, or a policy page that does not mention
automation. The two gates exist so that an answer has to be recorded before anything changes.
