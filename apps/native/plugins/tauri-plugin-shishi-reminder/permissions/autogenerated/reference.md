## Default Permission

Default permission set for the Shishi native plugin. The Shishi app normally
calls these commands from its Rust reminder adapter and secure-token bridge; do
not grant this set to arbitrary WebView content.

#### This default permission set includes the following:

- `allow-schedule`
- `allow-cancel`
- `allow-reschedule`
- `allow-list`
- `allow-clear`
- `allow-checkPermission`
- `allow-requestPermission`
- `allow-secureTokenGet`
- `allow-secureTokenSet`
- `allow-secureTokenRemove`

## Permission Table

<table>
<tr>
<th>Identifier</th>
<th>Description</th>
</tr>

<tr>
<td>

`shishi-reminder:allow-cancel`

</td>
<td>

Enables the cancel command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`shishi-reminder:deny-cancel`

</td>
<td>

Denies the cancel command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`shishi-reminder:allow-checkPermission`

</td>
<td>

Enables the checkPermission command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`shishi-reminder:deny-checkPermission`

</td>
<td>

Denies the checkPermission command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`shishi-reminder:allow-clear`

</td>
<td>

Enables the clear command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`shishi-reminder:deny-clear`

</td>
<td>

Denies the clear command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`shishi-reminder:allow-list`

</td>
<td>

Enables the list command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`shishi-reminder:deny-list`

</td>
<td>

Denies the list command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`shishi-reminder:allow-requestPermission`

</td>
<td>

Enables the requestPermission command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`shishi-reminder:deny-requestPermission`

</td>
<td>

Denies the requestPermission command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`shishi-reminder:allow-reschedule`

</td>
<td>

Enables the reschedule command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`shishi-reminder:deny-reschedule`

</td>
<td>

Denies the reschedule command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`shishi-reminder:allow-schedule`

</td>
<td>

Enables the schedule command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`shishi-reminder:deny-schedule`

</td>
<td>

Denies the schedule command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`shishi-reminder:allow-secureTokenGet`

</td>
<td>

Enables the secureTokenGet command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`shishi-reminder:deny-secureTokenGet`

</td>
<td>

Denies the secureTokenGet command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`shishi-reminder:allow-secureTokenRemove`

</td>
<td>

Enables the secureTokenRemove command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`shishi-reminder:deny-secureTokenRemove`

</td>
<td>

Denies the secureTokenRemove command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`shishi-reminder:allow-secureTokenSet`

</td>
<td>

Enables the secureTokenSet command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`shishi-reminder:deny-secureTokenSet`

</td>
<td>

Denies the secureTokenSet command without any pre-configured scope.

</td>
</tr>
</table>
