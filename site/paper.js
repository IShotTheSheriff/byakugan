// paper.js: the motion layer for paper.css. Load with `defer`. Every feature is optional and keyed off markup:
//   .reveal          fades up when it scrolls into view (stagger siblings with style="--i:1", "--i:2", ...)
//   .nav             gets .is-scrolled once the page scrolls
//   .nav-pill        a highlight (.nav-hi) slides under the hovered .nav-item
//   [data-words]     cycles comma-separated words: <span data-words="AI,a GPU,SQL"><span>AI</span></span>
//   .quiz            buttons with data-correct; reveals the sibling .quiz-why after any answer
// Reduced motion: reveals show at once, the rotator stays on its first word.
(() => {
  "use strict";
  document.documentElement.classList.add("js");
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;

  // scroll reveal
  const items = document.querySelectorAll(".reveal");
  if (still || !("IntersectionObserver" in window)) items.forEach((el) => el.classList.add("is-in"));
  else {
    const io = new IntersectionObserver((entries) => entries.forEach((e) => {
      if (e.isIntersecting) { e.target.classList.add("is-in"); io.unobserve(e.target); }
    }), { rootMargin: "0px 0px -8% 0px", threshold: 0.12 });
    items.forEach((el) => io.observe(el));
  }

  // nav border on scroll
  const nav = document.querySelector(".nav");
  if (nav) {
    const onScroll = () => nav.classList.toggle("is-scrolled", scrollY > 8);
    addEventListener("scroll", onScroll, { passive: true }); onScroll();
  }

  // sliding highlight in the nav pill
  document.querySelectorAll(".nav-pill").forEach((pill) => {
    const hi = pill.querySelector(".nav-hi");
    if (!hi) return;
    pill.querySelectorAll(".nav-item").forEach((item) => item.addEventListener("mouseenter", () => {
      hi.style.width = item.offsetWidth + "px";
      hi.style.transform = `translateX(${item.offsetLeft}px)`;
      pill.classList.add("hovering");
    }));
    pill.addEventListener("mouseleave", () => pill.classList.remove("hovering"));
  });

  // word rotator; the slot animates its width so the line re-centres smoothly
  document.querySelectorAll("[data-words]").forEach((slot) => {
    const words = slot.dataset.words.split(",").map((w) => w.trim()).filter(Boolean);
    const w = slot.querySelector("span");
    if (still || words.length < 2 || !w) return;
    let i = 0, timer = 0;
    const widthOf = (t) => { const p = w.cloneNode(); p.textContent = t; p.style.cssText = "position:absolute;visibility:hidden"; slot.append(p); const x = p.getBoundingClientRect().width; p.remove(); return x; };
    const next = () => {
      i = (i + 1) % words.length;
      w.classList.add("is-out");
      setTimeout(() => { w.textContent = words[i]; slot.style.width = widthOf(words[i]) + "px"; }, 220);
      setTimeout(() => w.classList.remove("is-out"), 420);
    };
    const run = () => { clearInterval(timer); if (!document.hidden) timer = setInterval(next, 2800); };
    (document.fonts ? document.fonts.ready : Promise.resolve()).then(() => { slot.style.width = widthOf(words[0]) + "px"; run(); });
    document.addEventListener("visibilitychange", run);
  });

  // quiz feedback
  document.querySelectorAll(".quiz").forEach((quiz) => {
    const why = quiz.parentElement.querySelector(".quiz-why");
    quiz.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
      const right = b.hasAttribute("data-correct");
      b.classList.remove("is-wrong"); void b.offsetWidth;
      b.classList.add(right ? "is-right" : "is-wrong");
      if (right && why) why.classList.add("is-in");
    }));
  });
})();
