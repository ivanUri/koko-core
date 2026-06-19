# execution_context_ordering

Uses CDP trace capture plus in-page realm probes to assert context creation occurs before the single coherent `Page.frameNavigated` publication point and that new-document script sees stable intrinsics.
